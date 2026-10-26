#if os(macOS)
import Darwin
import XCTest
@testable import DexterAppCore

final class LocalHostPortReuseTests: XCTestCase {
    func testProbeRefusesActiveListenerButAllowsItsRecentlyClosedConnections() throws {
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(listener, 0)
        guard listener >= 0 else { return }
        var listenerOpen = true
        defer { if listenerOpen { close(listener) } }
        var reuse: Int32 = 1
        XCTAssertEqual(setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)), 0)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        XCTAssertEqual(bound, 0)
        guard bound == 0 else { return }
        XCTAssertEqual(listen(listener, 1), 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        XCTAssertEqual(withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) }
        }, 0)
        let port = UInt16(bigEndian: address.sin_port)
        XCTAssertFalse(LocalHostSupervisor.loopbackPortIsFree(port))

        let client = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(client, 0)
        guard client >= 0 else { return }
        var clientOpen = true
        defer { if clientOpen { close(client) } }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(client, $0, length) }
        }
        XCTAssertEqual(connected, 0)
        guard connected == 0 else { return }
        let accepted = accept(listener, nil, nil)
        XCTAssertGreaterThanOrEqual(accepted, 0)
        guard accepted >= 0 else { return }
        defer { close(accepted) }
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        XCTAssertEqual(setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)), 0)
        XCTAssertEqual(setsockopt(accepted, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)), 0)
        // The server sends the first FIN, so its bound address retains TIME_WAIT after peer shutdown.
        XCTAssertEqual(shutdown(accepted, SHUT_WR), 0)
        var byte: UInt8 = 0
        XCTAssertEqual(recv(client, &byte, 1, 0), 0)
        close(client); clientOpen = false
        XCTAssertEqual(recv(accepted, &byte, 1, 0), 0)
        close(listener); listenerOpen = false
        XCTAssertTrue(LocalHostSupervisor.loopbackPortIsFree(port))
    }
}
#endif
