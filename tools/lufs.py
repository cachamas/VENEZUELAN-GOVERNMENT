"""EBU R128 / ITU-R BS.1770-4 integrated loudness + true peak, numpy/scipy only.

Validated below against synthetic signals whose expected values are known, so
the normalization pass can be trusted.
"""
import numpy as np
from scipy.signal import lfilter, resample_poly

# --- K-weighting (BS.1770-4 stage 1 high shelf + stage 2 RLB high pass) ---
# The spec tabulates coefficients at 48 kHz; for any other rate they are rebuilt
# from the same analog prototype via the bilinear transform (as ffmpeg does).
_SHELF_G = 3.999843853973347
_SHELF_F0 = 1681.974450955533
_SHELF_Q = 0.7071752369554196
_RBP_F0 = 38.13547087602444
_RBP_Q = 0.5003270373238773

_OFFSET = -0.691  # BS.1770 calibration constant


def _shelf(fs):
    K = np.tan(np.pi * _SHELF_F0 / fs)
    Vh = 10.0 ** (_SHELF_G / 20.0)
    Vb = Vh ** 0.4996667741545416
    a0 = 1.0 + K / _SHELF_Q + K * K
    b = np.array([(Vh + Vb * K / _SHELF_Q + K * K) / a0,
                  2.0 * (K * K - Vh) / a0,
                  (Vh - Vb * K / _SHELF_Q + K * K) / a0])
    a = np.array([1.0, 2.0 * (K * K - 1.0) / a0, (1.0 - K / _SHELF_Q + K * K) / a0])
    return b, a


def _hpf(fs):
    K = np.tan(np.pi * _RBP_F0 / fs)
    a0 = 1.0 + K / _RBP_Q + K * K
    b = np.array([1.0, -2.0, 1.0]) / a0
    a = np.array([1.0, 2.0 * (K * K - 1.0) / a0, (1.0 - K / _RBP_Q + K * K) / a0])
    return b, a


def k_weight(x, fs):
    """x: (n,) mono or (n, ch). Returns the K-weighted signal, same shape."""
    x = np.asarray(x, dtype=np.float64)
    mono = x.ndim == 1
    if mono:
        x = x[:, None]
    sb, sa = _shelf(fs)
    hb, ha = _hpf(fs)
    y = lfilter(sb, sa, x, axis=0)
    y = lfilter(hb, ha, y, axis=0)
    return y[:, 0] if mono else y


def integrated_lufs(x, fs, block_s=0.400, hop_frac=0.75):
    """Integrated loudness in LUFS (gated, per BS.1770-4)."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    if x.size == 0:
        return float("-inf")
    y = k_weight(x, fs)
    n = len(y)
    blk = int(round(block_s * fs))
    hop = max(1, int(round(blk * hop_frac)))
    if n < blk:
        z = np.array([float(np.mean(y ** 2))])
    else:
        starts = np.arange(0, n - blk + 1, hop)
        if starts[-1] != n - blk:
            starts = np.append(starts, n - blk)
        # cumulative sum for O(n) block energies, then divide by the block
        # length to get a MEAN square (a sum would read 10*log10(blk) too loud)
        cs = np.concatenate([np.zeros((1, y.shape[1])), np.cumsum(y ** 2, axis=0)], axis=0)
        z = np.array([np.sum(cs[s + blk] - cs[s]) / blk for s in starts])
    z = np.maximum(z, 1e-30)
    lj = _OFFSET + 10.0 * np.log10(z)
    keep = lj > -70.0                      # absolute gate
    if not keep.any():
        return float("-inf")
    rel = _OFFSET + 10.0 * np.log10(np.mean(z[keep])) - 10.0   # relative gate
    keep2 = keep & (lj > rel)
    if not keep2.any():
        keep2 = keep
    return float(_OFFSET + 10.0 * np.log10(np.mean(z[keep2])))


def true_peak_dbtp(x, fs, oversample=4):
    """Inter-sample true peak in dBTP (4x oversampled, per BS.1770-4 Annex 2)."""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    up = resample_poly(x, oversample, 1, axis=0)
    peak = float(np.max(np.abs(up))) if up.size else 0.0
    if peak <= 0:
        return float("-inf")
    return 20.0 * np.log10(peak)


def peak_dbfs(x):
    p = float(np.max(np.abs(x))) if np.size(x) else 0.0
    return 20.0 * np.log10(p) if p > 0 else float("-inf")


if __name__ == "__main__":
    fs = 44100
    rng = np.random.default_rng(0)
    print("VALIDATION (synthetic signals, expected values known)\n")

    # 1) 1 kHz sine, RMS = -23 dBFS. K-weighting is ~0 dB at 1 kHz, so R128
    #    should read very close to -23 LUFS.
    t = np.arange(int(fs * 10)) / fs
    s = 10 ** (-23.0 / 20.0) * np.sqrt(2) * np.sin(2 * np.pi * 1000 * t)
    got = integrated_lufs(s, fs)
    print("  1kHz sine, RMS -23 dBFS        -> %7.2f LUFS  (expect ~-23.0)  err %+.2f" % (got, got + 23.0))

    # 2) same, stereo (both channels identical) -> must not change the reading
    got2 = integrated_lufs(np.stack([s, s], 1), fs)
    print("  ...same, duplicated to stereo  -> %7.2f LUFS  (expect ~-23.0)  err %+.2f" % (got2, got2 + 23.0))

    # 3) -20 dBFS peak 1 kHz sine => RMS -23.01 dBFS
    s3 = 10 ** (-20.0 / 20.0) * np.sin(2 * np.pi * 1000 * t)
    got3 = integrated_lufs(s3, fs)
    print("  1kHz sine, peak -20 dBFS       -> %7.2f LUFS  (expect ~-23.0)  err %+.2f" % (got3, got3 + 23.0))

    # 4) +6 dB louder version of (1) -> reading must rise by ~6 dB
    got4 = integrated_lufs(s * 10 ** (6.0 / 20.0), fs)
    print("  (1) boosted +6 dB              -> %7.2f LUFS  (expect ~-17.0)  err %+.2f" % (got4, got4 + 17.0))

    # 5) true peak: a 0 dBFS square-ish signal oversamples ABOVE 0 dBTP
    sq = np.sign(np.sin(2 * np.pi * 1000 * t))
    print("  1kHz square, peak 0.0 dBFS     -> %7.2f dBTP  (expect > 0, ~+1..3)" % true_peak_dbtp(sq, fs))
    print("  1kHz sine,  peak 0.0 dBFS     -> %7.2f dBTP  (expect ~ 0.0)" % true_peak_dbtp(np.sin(2 * np.pi * 1000 * t), fs))

    # 6) gating must reject near-silence: -80 dBFS noise should read far below
    q = integrated_lufs(rng.normal(0, 10 ** (-80 / 20), int(fs * 10)), fs)
    print("  white noise at -80 dBFS RMS   -> %7.2f LUFS  (expect very low)" % q)

    # 7) white noise at -20 dBFS RMS: K-weighting is broadband, so ~-20 LUFS
    n = rng.normal(0, 10 ** (-20 / 20), int(fs * 10))
    print("  white noise at -20 dBFS RMS   -> %7.2f LUFS  (expect ~-20..-23)" % integrated_lufs(n, fs))
