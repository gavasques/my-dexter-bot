import DexterHostClient
import Foundation
import Observation

public enum AvatarImageGenerationCatalog {
    public static let modelID = "gpt-image-2.5-sunburst"
    public static let modelLabel = "GPT Image Sunburst 2.5"
    public static let endpoint = URL(string: "https://api.openai.com/v1/images/generations")!
}

public protocol AvatarImageGenerationTransport: Sendable {
    func send(_ request: URLRequest) async throws -> TransportResponse
}

/// Ephemeral, fixed-origin transport with redirects refused and a bounded streamed response.
public struct OpenAIAvatarImageTransport: AvatarImageGenerationTransport, Sendable {
    public init() {}
    public func send(_ request: URLRequest) async throws -> TransportResponse {
        guard request.url == AvatarImageGenerationCatalog.endpoint, request.httpMethod == "POST"
        else { throw AvatarImageFailure.invalidConfiguration }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 180; configuration.timeoutIntervalForResource = 180
        let session = URLSession(configuration: configuration, delegate: AvatarImageRedirectGuard(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.url == request.url
        else { throw AvatarImageFailure.responseInvalid }
        let maximum = 16 * 1_024 * 1_024
        guard response.expectedContentLength <= Int64(maximum) else { throw AvatarImageFailure.responseInvalid }
        var data = Data()
        if response.expectedContentLength > 0 { data.reserveCapacity(Int(response.expectedContentLength)) }
        for try await byte in bytes {
            guard data.count < maximum else { throw AvatarImageFailure.responseInvalid }
            data.append(byte)
        }
        try Task.checkCancellation()
        return TransportResponse(statusCode: response.statusCode, data: data)
    }
}

private final class AvatarImageRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct AvatarImageGenerationRequest: Encodable, Sendable {
    let model = AvatarImageGenerationCatalog.modelID
    let prompt: String
    let n = 1
    let size = "1024x1024"
    let quality = "low"
    let output_format = "png"
    let background = "transparent"
}
private struct AvatarImageGenerationResponse: Decodable, Sendable {
    struct Image: Decodable, Sendable { let b64_json: String? }
    let data: [Image]
}

@MainActor @Observable public final class AvatarEditorController {
    public private(set) var imageDraft: AvatarImageDraft?
    /// Image draft an explicit mascot choice set aside. Kept by this editor (the window's, per bot), in process memory only,
    /// so it survives page switches and "Remover mascote" gives back the same bytes without a new upload or paid request.
    /// Cleared by an explicit image decision (import, generation, Remover imagem), by Save/Descartar/Recarregar (all call
    /// `removeImage`) and when the window's host scope retires.
    public private(set) var setAsideImageDraft: AvatarImageDraft?
    public private(set) var isGenerating = false
    public private(set) var safeMessage: String?
    public private(set) var keyStatus: AvatarImageKeyStatus = .missing
    @ObservationIgnored private let keyStore: any AvatarImageAPIKeyStore
    @ObservationIgnored private let transport: any AvatarImageGenerationTransport
    @ObservationIgnored private var generationTask: Task<AvatarImageDraft, Error>?
    @ObservationIgnored private var generationToken: UUID?

    public init(keyStore: (any AvatarImageAPIKeyStore)? = nil,
                transport: (any AvatarImageGenerationTransport)? = nil) {
        self.keyStore = keyStore ?? ScopedAvatarImageAPIKeychain()
        self.transport = transport ?? OpenAIAvatarImageTransport()
    }

    public func selectImage(_ bytes: Data) throws {
        guard !isGenerating else { throw AvatarImageFailure.invalidConfiguration }
        imageDraft = try AvatarImageNormalizer.normalize(bytes); setAsideImageDraft = nil; safeMessage = nil
    }
    public func removeImage() { imageDraft = nil; setAsideImageDraft = nil; safeMessage = nil }

    /// Explicit mascot choice: the current image draft moves aside (no-op without one).
    public func setAsideImageDraftForMascot() {
        guard let imageDraft else { return }
        setAsideImageDraft = imageDraft; self.imageDraft = nil; safeMessage = nil
    }
    /// "Remover mascote": the set-aside draft comes back unchanged. False when there is nothing to give back.
    @discardableResult public func restoreSetAsideImageDraft() -> Bool {
        guard !isGenerating, let draft = setAsideImageDraft else { return false }
        imageDraft = draft; setAsideImageDraft = nil; safeMessage = nil
        return true
    }
    public func forgetSetAsideImageDraft() { setAsideImageDraft = nil }
    /// X/Escape of the mascot sheet: both drafts return to the values captured when it opened.
    public func restoreDrafts(imageDraft: AvatarImageDraft?, setAside: AvatarImageDraft?) {
        guard !isGenerating else { return }
        self.imageDraft = imageDraft; setAsideImageDraft = setAside
    }
    public func refreshKeyStatus(hostID: String) { keyStatus = keyStore.status(hostID: hostID) }
    public func saveKey(_ value: String, hostID: String) throws {
        guard !isGenerating else { throw AvatarImageFailure.invalidConfiguration }
        try keyStore.save(value, hostID: hostID); refreshKeyStatus(hostID: hostID); safeMessage = String(localized: "Chave salva neste Mac para este host.")
    }
    public func removeKey(hostID: String) throws {
        guard !isGenerating else { throw AvatarImageFailure.invalidConfiguration }
        try keyStore.remove(hostID: hostID); refreshKeyStatus(hostID: hostID); safeMessage = String(localized: "Chave removida deste Mac.")
    }

    /// A human click starts one chargeable request. Cancellation/unknown outcomes never trigger another call.
    @discardableResult public func generate(prompt: String, hostID: String) async -> Bool {
        guard !isGenerating else { return false }
        let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.utf16.count <= 2_000 else {
            safeMessage = AvatarImageFailure.invalidPrompt.localizedDescription; return false
        }
        guard !hostID.isEmpty, hostID.utf8.count <= 128,
              !hostID.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            safeMessage = AvatarImageFailure.invalidConfiguration.localizedDescription; return false
        }
        let key: String
        do {
            key = try keyStore.load(hostID: hostID)
            guard AvatarImageKeyValidation.isValid(key) else { throw AvatarImageFailure.keyUnavailable }
        } catch {
            safeMessage = (error as? AvatarImageFailure ?? .keyUnavailable).localizedDescription
            refreshKeyStatus(hostID: hostID); return false
        }
        var request = URLRequest(url: AvatarImageGenerationCatalog.endpoint)
        request.httpMethod = "POST"; request.timeoutInterval = 180
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do { request.httpBody = try JSONEncoder().encode(AvatarImageGenerationRequest(prompt: prompt)) }
        catch { safeMessage = AvatarImageFailure.invalidConfiguration.localizedDescription; return false }

        let token = UUID(), transport = transport
        generationToken = token; isGenerating = true; safeMessage = nil
        let task = Task<AvatarImageDraft, Error> {
            try Task.checkCancellation()
            let response: TransportResponse
            do { response = try await transport.send(request) }
            catch let error as AvatarImageFailure { throw error }
            catch { throw AvatarImageFailure.outcomeUnknown }
            try Task.checkCancellation()
            switch response.statusCode {
            case 200..<300: break
            case 401, 403: throw AvatarImageFailure.authenticationRejected
            case 429: throw AvatarImageFailure.rateLimited
            case 500...599: throw AvatarImageFailure.outcomeUnknown
            default: throw AvatarImageFailure.providerRejected
            }
            guard response.data.count <= 16 * 1_024 * 1_024,
                  let value = try? JSONDecoder().decode(AvatarImageGenerationResponse.self, from: response.data),
                  value.data.count == 1, let encoded = value.data[0].b64_json,
                  encoded.utf8.count <= 13_981_016, let image = Data(base64Encoded: encoded),
                  image.base64EncodedString() == encoded else { throw AvatarImageFailure.responseInvalid }
            do { return try AvatarImageNormalizer.normalize(image) }
            catch { throw AvatarImageFailure.responseInvalid }
        }
        generationTask = task
        defer {
            if generationToken == token { generationTask = nil; generationToken = nil; isGenerating = false }
        }
        let outcome = await withTaskCancellationHandler {
            await task.result
        } onCancel: { task.cancel() }
        guard generationToken == token, !Task.isCancelled else { return false }
        switch outcome {
        case .success(let image):
            imageDraft = image; setAsideImageDraft = nil
            safeMessage = String(localized: "Avatar gerado. Salve o perfil para aplicá-lo."); return true
        case .failure(let error):
            safeMessage = (error as? AvatarImageFailure ?? .outcomeUnknown).localizedDescription; return false
        }
    }

    public func cancelGeneration() {
        guard isGenerating else { return }
        generationTask?.cancel(); generationTask = nil; generationToken = nil; isGenerating = false
        safeMessage = AvatarImageFailure.outcomeUnknown.localizedDescription
    }
}
