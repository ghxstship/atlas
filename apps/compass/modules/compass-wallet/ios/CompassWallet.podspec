Pod::Spec.new do |s|
  s.name             = 'CompassWallet'
  s.version          = '4.0.0'
  s.summary          = 'Adds Compass credentials and shift passes to Apple Wallet.'
  s.description      = 'PassKit for Compass (A65-011 part 4): the Add to Apple Wallet button and the add-pass sheet.'
  s.author           = 'GHXSTSHIP'
  s.homepage         = 'https://github.com/ghxstship/atlas'
  s.license          = 'AGPL-3.0-only'
  s.platforms        = { :ios => '15.1' }
  s.source           = { git: '' }
  s.static_framework = true
  s.swift_version    = '5.9'
  s.dependency 'ExpoModulesCore'
  s.frameworks       = 'PassKit'
  s.source_files     = '**/*.swift'
end
