Pod::Spec.new do |s|
  s.name             = 'CompassLiveActivity'
  s.version          = '4.0.0'
  s.summary          = 'Starts, updates and ends the Compass clock Live Activity and drains its punch queue.'
  s.description      = 'The app side of the Compass clock Live Activity (SIM-005): ActivityKit and the App Group punch queue.'
  s.author           = 'GHXSTSHIP'
  s.homepage         = 'https://github.com/ghxstship/atlas'
  s.license          = 'AGPL-3.0-only'
  s.platforms        = { :ios => '15.1' }
  s.source           = { git: '' }
  s.static_framework = true
  s.swift_version    = '5.9'
  s.dependency 'ExpoModulesCore'
  s.source_files     = '**/*.swift'
end
