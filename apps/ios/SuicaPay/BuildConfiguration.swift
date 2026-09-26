import Foundation

struct BuildConfiguration {
    let apiURL: URL
    let webURL: URL
    let previousAPIURL: URL?

    static func load(bundle: Bundle = .main) throws -> BuildConfiguration {
        try parse(api: bundle.object(forInfoDictionaryKey: "SUICA_API_BASE_URL") as? String,
                  web: bundle.object(forInfoDictionaryKey: "SUICA_WEB_BASE_URL") as? String,
                  previousAPI: bundle.object(forInfoDictionaryKey: "SUICA_PREVIOUS_API_BASE_URL") as? String)
    }

    static func parse(api: String?, web: String?, previousAPI: String? = nil) throws -> BuildConfiguration {
        guard let api, let web, !api.contains("$("), !web.contains("$(") else {
            throw AppError.message("IC Pay is temporarily unavailable. Please try again later.")
        }
        let previous: URL?
        if let previousAPI, !previousAPI.isEmpty, !previousAPI.contains("$(") { previous = try APIClient.validatedURL(previousAPI) }
        else { previous = nil }
        return try BuildConfiguration(apiURL: APIClient.validatedURL(api), webURL: APIClient.validatedURL(web), previousAPIURL: previous)
    }
}
