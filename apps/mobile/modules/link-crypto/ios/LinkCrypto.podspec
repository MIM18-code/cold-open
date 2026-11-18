Pod::Spec.new do |s|
  s.name = 'LinkCrypto'
  s.version = '0.1.0'
  s.summary = 'CryptoKit primitives for the Cold Open sealed Wi-Fi link'
  s.homepage = 'https://github.com/MIM18-code/cold-open'
  s.license = 'GPL-3.0-only'
  s.author = 'MindInMotion'
  s.source = { :git => 'https://github.com/MIM18-code/cold-open.git' }
  s.platform = :ios, '16.4'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CryptoKit', 'Security'
  s.source_files = '*.swift'
end
