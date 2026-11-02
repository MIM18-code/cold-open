Pod::Spec.new do |s|
  s.name = 'PhoneFolder'
  s.version = '0.1.0'
  s.summary = 'Files folder access for the Cold Open phone inbox'
  s.homepage = 'https://github.com/MIM18-code/cold-open'
  s.license = 'GPL-3.0-only'
  s.author = 'MindInMotion'
  s.source = { :git => 'https://github.com/MIM18-code/cold-open.git' }
  s.platform = :ios, '16.4'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'UniformTypeIdentifiers'
  s.source_files = '*.swift'
end
