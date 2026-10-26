#if os(iOS) && canImport(HealthKit)
import Foundation
import HealthKit

/// No HealthKit calls at initialization. Do not construct/call from an automatic/background/engine path.
/// The containing application still needs its own entitlement and usage description before integration.
@available(iOS 17.0, *)
public actor HealthKitStepBackend: LocalStepBackend {
    private var store: HKHealthStore?
    public init() {}

    private func healthStore() -> HKHealthStore {
        if let store { return store }
        let created = HKHealthStore()
        store = created
        return created
    }

    public func requestReadAuthorization() async throws -> StepAuthorizationResult {
        try Task.checkCancellation()
        guard HKHealthStore.isHealthDataAvailable() else { return .dataUnavailable }
        do {
            try await healthStore().requestAuthorization(toShare: [], read: [HKQuantityType(.stepCount)])
            try Task.checkCancellation()
            return .authorizationRequested
        } catch is CancellationError { throw CancellationError() }
        catch { throw HealthCapabilityError.backendUnavailable }
    }

    public func dailySteps(in interval: UTCStepInterval) async throws -> StepReadResult {
        try Task.checkCancellation()
        guard HKHealthStore.isHealthDataAvailable() else { return .dataUnavailable }
        let store = healthStore()
        var rows: [DailyStepCount] = []
        do {
            for day in interval.days {
                try Task.checkCancellation()
                let predicate = HKQuery.predicateForSamples(withStart: day,
                    end: day.addingTimeInterval(UTCStepInterval.secondsPerDay), options: [.strictStartDate, .strictEndDate])
                let descriptor = HKStatisticsQueryDescriptor(
                    predicate: .quantitySample(type: HKQuantityType(.stepCount), predicate: predicate), options: .cumulativeSum)
                let statistics = try await descriptor.result(for: store)
                try Task.checkCancellation()
                if let sum = statistics?.sumQuantity() {
                    rows.append(DailyStepCount(utcDay: day, count: sum.doubleValue(for: .count())))
                }
            }
            return rows.isEmpty ? .emptyOrUnavailable : .data(rows)
        } catch is CancellationError { throw CancellationError() }
        catch { throw HealthCapabilityError.backendUnavailable }
    }
}
#endif
