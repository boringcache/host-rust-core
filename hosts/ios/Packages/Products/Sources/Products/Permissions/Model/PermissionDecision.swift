import Foundation

public enum PermissionDecisionError: Error {
    case alreadyConsumed
}

/// Outcome of a permission prompt.
public enum PermissionDecision: Sendable, Equatable {
    case allowAlways
    case allowOnce
    case deny
}
