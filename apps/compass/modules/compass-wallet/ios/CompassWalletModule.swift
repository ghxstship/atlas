// Apple Wallet for Compass (A65-011 part 4; Section 11.10 item 14, Section 11.13: the badge in one tap from
// the lock screen). The JS side fetches the signed pass from the wallet-pass Edge Function and hands its
// bytes here; PassKit shows its own add-pass sheet, and the pass then lives in Wallet and works offline.
// The button is Apple's PKAddPassButton, the badge Apple's guidelines ask for, with its own VoiceOver label.
import ExpoModulesCore
import PassKit
import UIKit

public class CompassWalletModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CompassWallet")

    /// True when this device can add passes to Wallet.
    Function("canAddPasses") { () -> Bool in
      PKAddPassesViewController.canAddPasses()
    }

    /// Shows the add-pass sheet for a signed .pkpass (base64). Resolves once the sheet is up.
    AsyncFunction("addPass") { (base64: String, promise: Promise) in
      guard let data = Data(base64Encoded: base64) else {
        promise.reject("E_PASS_DATA", "The pass could not be read.")
        return
      }
      let pass: PKPass
      do {
        pass = try PKPass(data: data)
      } catch {
        promise.reject("E_PASS_INVALID", error.localizedDescription)
        return
      }
      guard let sheet = PKAddPassesViewController(pass: pass),
        let presenter = self.appContext?.utilities?.currentViewController()
      else {
        promise.reject("E_PASS_SHEET", "Wallet could not open.")
        return
      }
      presenter.present(sheet, animated: true)
      promise.resolve(true)
    }.runOnQueue(.main)

    View(CompassAddPassButtonView.self) {
      Events("onPress")
    }
  }
}

/// Apple's Add to Apple Wallet button.
public class CompassAddPassButtonView: ExpoView {
  let onPress = EventDispatcher()
  private let button = PKAddPassButton(addPassButtonStyle: .black)

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    button.addTarget(self, action: #selector(pressed), for: .touchUpInside)
    addSubview(button)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    button.frame = bounds
  }

  @objc private func pressed() {
    onPress([:])
  }
}
