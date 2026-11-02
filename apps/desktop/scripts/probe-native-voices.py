#!/usr/bin/env python3
"""Exercise the shipped JSON protocol with real weights and synthetic screenplay lines.

Downloads public model weights only when explicitly run. Never reads a user script.
Passing means nonempty valid audio was generated, not a human quality endorsement.
"""
import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import selectors
import struct
import subprocess
import time
import wave


def inspect_wav(data):
    with wave.open(io.BytesIO(data), 'rb') as wav:
        channels, width, rate, frames = wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()
        raw = wav.readframes(frames)
    if width != 2 or channels not in (1, 2) or rate < 8000 or frames < rate // 20:
        raise ValueError(f'Unexpected audio format: {channels} channels, {width} bytes, {rate} Hz, {frames} frames')
    samples = struct.unpack('<' + 'h' * (len(raw) // 2), raw)
    peak = max(abs(x) for x in samples) / 32768
    rms = math.sqrt(sum((x / 32768) ** 2 for x in samples) / len(samples))
    if rms < 0.00001:
        raise ValueError('Generated waveform is effectively silent')
    return {'sampleRate': rate, 'channels': channels, 'seconds': frames / rate,
            'peak': peak, 'rms': rms, 'clippedFraction': sum(abs(x) >= 32760 for x in samples) / len(samples),
            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


class Protocol:
    def __init__(self, helper, log):
        self.process = subprocess.Popen([str(helper), 'serve'], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=log, start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''
        self.next_id = 0

    def request(self, timeout, **payload):
        self.next_id += 1
        payload['id'] = self.next_id
        self.process.stdin.write(json.dumps(payload).encode() + b'\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                result = json.loads(line)
                if result.get('id') != self.next_id:
                    raise RuntimeError('Unexpected response ID')
                if not result.get('ok'):
                    raise RuntimeError(str(result.get('error', 'Native model failed')))
                return result
            if not self.selector.select(max(0, min(1, deadline - time.monotonic()))):
                if self.process.poll() is not None:
                    raise RuntimeError(f'Voice helper exited with status {self.process.returncode}; inspect stderr')
                continue
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('Voice helper closed its protocol stream')
            self.buffer += chunk
            if len(self.buffer) > 24 * 1024 * 1024:
                raise RuntimeError('Voice response exceeded its protocol bound')
        raise TimeoutError(f'Native {payload["op"]} exceeded {timeout} seconds')

    def close(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.process.kill()
            self.process.wait(timeout=5)
        finally:
            self.selector.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--helper', type=Path, required=True)
    parser.add_argument('--engine', choices=['phonon', 'ming'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    result = {'engine': args.engine, 'source': os.environ.get('GITHUB_SHA', 'local'),
              'claim': 'Real inference and waveform checks only; human listening remains required', 'samples': [], 'status': 'failed'}
    protocol = None
    try:
        with (args.output / 'stderr.log').open('wb') as log:
            protocol = Protocol(args.helper.resolve(), log)
            start = time.monotonic()
            prepared = protocol.request(900, op='prepare', engine=args.engine)
            result['prepareSeconds'] = time.monotonic() - start
            voices = prepared.get('voices', [])
            if not voices:
                raise RuntimeError('No English voices available after prepare')
            result['availableVoices'] = voices
            lines = ['No.', 'You said the kitchen door was locked.',
                     'I said I locked it. Those are different things.',
                     'Interior. Kitchen. Night. Mara sets the untouched cup on the counter.']
            for index, text in enumerate(lines):
                voice = voices[index % min(2, len(voices))]
                start = time.monotonic()
                response = protocol.request(150, op='synthesize', engine=args.engine, voice=voice, text=text)
                elapsed = time.monotonic() - start
                audio = base64.b64decode(response['audio'], validate=True)
                metrics = inspect_wav(audio)
                name = f'{index + 1:02d}.wav'
                (args.output / name).write_bytes(audio)
                result['samples'].append({'file': name, 'text': text, 'voice': voice, 'generationSeconds': elapsed,
                                          'realTimeFactor': elapsed / metrics['seconds'], **metrics})
            result['status'] = 'passed'
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}'
    finally:
        if protocol:
            protocol.close()
        (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
