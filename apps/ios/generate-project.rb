#!/usr/bin/env ruby
require 'xcodeproj'
root = File.expand_path(__dir__)
project = Xcodeproj::Project.new(File.join(root, 'SuicaPay.xcodeproj'))
target = project.new_target(:application, 'SuicaPay', :ios, '18.0')
world_package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
world_package.relative_path = 'Vendor/IDKit'
project.root_object.package_references << world_package
world_product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
world_product.product_name = 'IDKit'
target.package_product_dependencies << world_product
world_build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
world_build_file.product_ref = world_product
target.frameworks_build_phase.files << world_build_file

group = project.main_group.new_group('SuicaPay', 'SuicaPay')
Dir.glob(File.join(root, 'SuicaPay', '*.swift')).sort.each { |f| target.source_build_phase.add_file_reference(group.new_file(File.basename(f))) }
target.resources_build_phase.add_file_reference(group.new_file('Assets.xcassets'))
group.new_file('Info.plist'); group.new_file('SuicaPay.entitlements')
configuration_group = project.main_group.new_group('Config', 'Config')
base_configuration = configuration_group.new_file('Base.xcconfig')
configuration_group.new_file('Environment.example.xcconfig')
target.build_configurations.each do |config|
  config.base_configuration_reference = base_configuration
  config.build_settings.merge!({ 'DEVELOPMENT_TEAM' => ENV.fetch('APPLE_DEVELOPMENT_TEAM', '3GV5LC5UDM'), 'PRODUCT_BUNDLE_IDENTIFIER' => 'app.suicapay.demo', 'SWIFT_VERSION' => '5.0', 'INFOPLIST_FILE' => 'SuicaPay/Info.plist', 'CODE_SIGN_ENTITLEMENTS' => 'SuicaPay/SuicaPay.entitlements', 'CODE_SIGN_STYLE' => 'Automatic', 'TARGETED_DEVICE_FAMILY' => '1', 'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME' => 'AccentColor', 'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES' })
end
tests = project.new_target(:unit_test_bundle, 'SuicaPayTests', :ios, '18.0')
tests.add_dependency(target)
test_group = project.main_group.new_group('SuicaPayTests', 'SuicaPayTests')
Dir.glob(File.join(root, 'SuicaPayTests', '*.swift')).sort.each { |f| tests.source_build_phase.add_file_reference(test_group.new_file(File.basename(f))) }
tests.build_configurations.each do |config|
  config.build_settings.merge!({ 'DEVELOPMENT_TEAM' => ENV.fetch('APPLE_DEVELOPMENT_TEAM', '3GV5LC5UDM'), 'PRODUCT_BUNDLE_IDENTIFIER' => 'app.suicapay.demo.tests', 'SWIFT_VERSION' => '5.0', 'GENERATE_INFOPLIST_FILE' => 'YES', 'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/SuicaPay.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/SuicaPay', 'BUNDLE_LOADER' => '$(TEST_HOST)' })
end
ui_tests = project.new_target(:ui_test_bundle, 'SuicaPayUITests', :ios, '18.0')
ui_tests.add_dependency(target)
ui_test_group = project.main_group.new_group('SuicaPayUITests', 'SuicaPayUITests')
Dir.glob(File.join(root, 'SuicaPayUITests', '*.swift')).sort.each { |f| ui_tests.source_build_phase.add_file_reference(ui_test_group.new_file(File.basename(f))) }
ui_tests.build_configurations.each do |config|
  config.build_settings.merge!({ 'DEVELOPMENT_TEAM' => ENV.fetch('APPLE_DEVELOPMENT_TEAM', '3GV5LC5UDM'), 'PRODUCT_BUNDLE_IDENTIFIER' => 'app.suicapay.demo.uitests', 'SWIFT_VERSION' => '5.0', 'GENERATE_INFOPLIST_FILE' => 'YES', 'TEST_TARGET_NAME' => 'SuicaPay' })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(tests)
scheme.set_launch_target(target)
scheme.save_as(project.path, 'SuicaPay', true)
ui_scheme = Xcodeproj::XCScheme.new
ui_scheme.add_build_target(target)
ui_scheme.add_test_target(ui_tests)
ui_scheme.set_launch_target(target)
ui_scheme.save_as(project.path, 'SuicaPayDeviceRegression', true)
