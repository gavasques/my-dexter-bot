import Foundation

/// JSON values used by tool arguments and host event payloads.
public enum JSONValue: Codable, Equatable, Hashable, Sendable {
    case null
    case bool(Bool)
    case integer(Int64)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let scalar = try decoder.singleValueContainer()
        if scalar.decodeNil() {
            self = .null
        } else if let value = try? scalar.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? scalar.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? scalar.decode(Double.self) {
            self = .number(value)
        } else if let value = try? scalar.decode(String.self) {
            self = .string(value)
        } else if var values = try? decoder.unkeyedContainer() {
            var result: [JSONValue] = []
            while !values.isAtEnd {
                result.append(try values.decode(JSONValue.self))
            }
            self = .array(result)
        } else {
            let values = try decoder.container(keyedBy: DynamicKey.self)
            self = .object(try Dictionary(uniqueKeysWithValues: values.allKeys.map {
                ($0.stringValue, try values.decode(JSONValue.self, forKey: $0))
            }))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        case .bool(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .integer(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .number(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .string(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .array(let value):
            var container = encoder.unkeyedContainer()
            for item in value { try container.encode(item) }
        case .object(let value):
            var container = encoder.container(keyedBy: DynamicKey.self)
            for (key, item) in value {
                try container.encode(item, forKey: DynamicKey(stringValue: key)!)
            }
        }
    }

    public var formattedJSON: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(self), let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }
}

private struct DynamicKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}
