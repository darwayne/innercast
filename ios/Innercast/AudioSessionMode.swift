import AVFoundation

enum AudioSessionMode: String, CaseIterable, Identifiable {
    case standard
    case measurement

    var id: Self { self }

    var title: String {
        switch self {
        case .standard:
            return "Default"
        case .measurement:
            return "Measurement"
        }
    }

    var detail: String {
        switch self {
        case .standard:
            return "Normal play-and-record behavior"
        case .measurement:
            return "Minimizes system signal processing where possible"
        }
    }

    var avMode: AVAudioSession.Mode {
        switch self {
        case .standard:
            return .default
        case .measurement:
            return .measurement
        }
    }
}
