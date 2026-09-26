import Foundation
import Security
import CryptoKit

enum Keychain {
    static let service = "app.suicapay.credentials"
    static func read(_ key: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status != errSecItemNotFound else { return nil }
        guard status == errSecSuccess else { throw AppError.message("Secure storage could not be read. Unlock the iPhone and retry.") }
        return item as? Data
    }
    static func save(_ data: Data?, key: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        if let data {
            let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var attributes = query
                attributes[kSecValueData as String] = data
                attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else { throw AppError.message("Could not save credentials securely.") }
            } else if status != errSecSuccess { throw AppError.message("Could not update secure credentials.") }
        } else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw AppError.message("Could not remove secure credentials.") }
        }
    }
}
struct TerminalSigner {
    private let key: SecureEnclave.P256.Signing.PrivateKey
    init() throws {
        guard SecureEnclave.isAvailable else { throw AppError.message("Terminal enrollment requires an iPhone with Secure Enclave. The simulator cannot collect payments.") }
        if let representation = try Keychain.read("terminal-signing-key") {
            key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: representation)
        } else {
            let generated = try SecureEnclave.P256.Signing.PrivateKey()
            try Keychain.save(generated.dataRepresentation, key: "terminal-signing-key")
            key = generated
        }
    }
    var publicKey: String { key.publicKey.derRepresentation.base64EncodedString() }
    func sign(_ payload: ScanPayload) throws -> String {
        try key.signature(for: payload.canonicalBytes()).derRepresentation.base64EncodedString()
    }
}
