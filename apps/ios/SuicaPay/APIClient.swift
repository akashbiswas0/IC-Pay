import Foundation

struct APIRequestError: LocalizedError {
    let status: Int
    let code: String
    let message: String
    var errorDescription: String? { message }
}

@MainActor struct APIClient {
    private struct Failure: Decodable { struct Detail: Decodable { let code: String; let message: String }; let error: Detail }
    let baseURL: URL
    let token: String?
    var session: URLSession = .shared
    nonisolated static func validatedURL(_ text: String) throws -> URL {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw AppError.message("IC Pay is temporarily unavailable. Please try again later.")
        }
        return url
    }
    func call<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil, query: [URLQueryItem] = []) async throws -> T {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw AppError.message("Invalid request address.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if baseURL.host?.hasSuffix(".ngrok-free.dev") == true { request.setValue("1", forHTTPHeaderField: "ngrok-skip-browser-warning") }
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw AppError.message("The server returned an invalid response.") }
        guard (200..<300).contains(response.statusCode) else {
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            throw APIRequestError(status: response.statusCode, code: failure?.error.code ?? "request_failed", message: failure?.error.message ?? "We couldn’t complete that request. Please try again.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func json<T: Decodable>(_ path: String, method: String = "POST", body: [String: Any]) async throws -> T {
        try await call(path, method: method, body: JSONSerialization.data(withJSONObject: body))
    }
}

/// Every response is checked against the session that issued it before it reaches UI state.
@MainActor struct SessionAPIClient {
    let client: APIClient
    let isCurrent: () -> Bool
    func call<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil, query: [URLQueryItem] = []) async throws -> T {
        guard isCurrent() else { throw CancellationError() }
        let result: T
        do { result = try await client.call(path, method: method, body: body, query: query) }
        catch {
            guard isCurrent() else { throw CancellationError() }
            throw error
        }
        guard isCurrent() else { throw CancellationError() }
        return result
    }
    func json<T: Decodable>(_ path: String, method: String = "POST", body: [String: Any]) async throws -> T {
        try await call(path, method: method, body: JSONSerialization.data(withJSONObject: body))
    }
}
