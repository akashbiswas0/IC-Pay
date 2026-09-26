import Foundation
import CoreNFC

final class CardReader: NSObject, NFCTagReaderSessionDelegate, @unchecked Sendable {
    private var session: NFCTagReaderSession?
    private var continuation: CheckedContinuation<String, Error>?
    private var accepted = false
    static var available: Bool { NFCTagReaderSession.readingAvailable }
    @MainActor func scan(message: String) async throws -> String {
        guard Self.available else { throw AppError.message("Card reading requires a compatible physical iPhone. NFC is unavailable in the simulator.") }
        guard session == nil else { throw AppError.message("A card scan is already in progress.") }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            accepted = false
            session = NFCTagReaderSession(pollingOption: .iso18092, delegate: self, queue: .main)
            session?.alertMessage = message
            session?.begin()
        }
    }
    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {}
    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        if let continuation {
            self.continuation = nil
            let nfc = error as? NFCReaderError
            continuation.resume(throwing: AppError.message(nfc?.code == .readerSessionInvalidationErrorUserCanceled ? "Card scan cancelled." : error.localizedDescription))
        }
        self.session = nil
    }
    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard !accepted else { return }
        guard tags.count == 1, let first = tags.first else {
            session.alertMessage = "Hold one physical transit IC card near the top of your iPhone."
            session.restartPolling()
            return
        }
        guard case .feliCa(let card) = first else {
            session.invalidate(errorMessage: "This card is not a supported transit IC card.")
            return
        }
        accepted = true
        session.connect(to: first) { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error { session.invalidate(errorMessage: error.localizedDescription); return }
                guard card.currentSystemCode == Data([0x00, 0x03]), card.currentIDm.count == 8 else {
                    session.invalidate(errorMessage: "A compatible FeliCa transit IC card is required.")
                    return
                }
                let cardID = card.currentIDm.map { String(format: "%02X", $0) }.joined()
                let continuation = self.continuation
                self.continuation = nil
                session.alertMessage = "Card read."
                session.invalidate()
                continuation?.resume(returning: cardID)
            }
        }
    }
}
