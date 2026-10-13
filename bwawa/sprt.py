"""The SPRT of a match from its game pairs, the way OpenBench (and fishtest) computes it, and where it's heading.

LLR: the pentanomial normalized-Elo GSPRT (https://hardy.uhasselt.be/Fishtest/normalized_elo_practical.pdf), a port of
OpenBench's stats.py without scipy. A game pair scores 0, ½, 1, 1½ or 2 for dev, the pentanomial counts each.

Projection: with the pair outcome probabilities held where they are, every pair adds the log-ratio of its outcome to
the LLR, so the LLR is a random walk with a drift and a variance per pair. A Brownian motion with that drift between
the two bounds gives the chance of passing and the expected number of pairs until one is hit (Wald's approximations).
"""
from __future__ import annotations

import math

NELO_DIVIDED_BY_NT = 800 / math.log(10)


def bounds(alpha: float = 0.05, beta: float = 0.05) -> tuple[float, float]:
    return math.log(beta / (1 - alpha)), math.log((1 - beta) / alpha)


def _stats(pdf: list[tuple[float, float]]) -> tuple[float, float]:
    mean = sum(p * a for a, p in pdf)
    return mean, sum(p * (a - mean) ** 2 for a, p in pdf)


def _secular(pdf: list[tuple[float, float]]) -> float:
    """The root of sum(p*a / (1 + x*a)) = 0 between -1/max(a) and -1/min(a), by bisection (scipy's brentq in
    OpenBench, the same root)."""
    values = [a for a, _ in pdf]
    low, high = -1 / max(values) + 1e-9, -1 / min(values) - 1e-9

    def f(x: float) -> float:
        return sum(p * a / (1 + x * a) for a, p in pdf)

    f_low = f(low)
    for _ in range(200):
        mid = (low + high) / 2
        f_mid = f(mid)
        if (f_mid > 0) == (f_low > 0):
            low, f_low = mid, f_mid
        else:
            high = mid
        if high - low < 1e-15:
            break
    return (low + high) / 2


def _mle(pdfhat: list[tuple[float, float]], ref: float, s: float) -> list[tuple[float, float]]:
    """The outcome probabilities closest to the observed ones whose normalized t-value is s."""
    pdf_mle = [(a, 1 / len(pdfhat)) for a, _ in pdfhat]
    for _ in range(10):
        previous = pdf_mle
        mu, var = _stats(pdf_mle)
        sigma = var ** 0.5
        shifted = [(a - ref - s * sigma * (1 + ((mu - a) / sigma) ** 2) / 2, p) for a, p in pdfhat]
        x = _secular(shifted)
        pdf_mle = [(pdfhat[i][0], pdfhat[i][1] / (1 + x * shifted[i][0])) for i in range(len(pdfhat))]
        if max(abs(previous[i][1] - pdf_mle[i][1]) for i in range(len(pdfhat))) < 1e-9:
            break
    return pdf_mle


def _model(penta: list[int], elo0: float, elo1: float):
    """Pairs, observed outcome probabilities and those under H0 and H1."""
    counts = [max(1e-3, x) for x in penta]
    pairs = sum(counts)
    pdf = [(i / 4, counts[i] / pairs) for i in range(5)]
    t0, t1 = (elo / NELO_DIVIDED_BY_NT * math.sqrt(2) for elo in (elo0, elo1))
    return pairs, pdf, _mle(pdf, 0.5, t0), _mle(pdf, 0.5, t1)


def llr(penta: list[int], elo0: float, elo1: float) -> float:
    """OpenBench's PentanomialSPRT: penta is [LL, LD, DD/WL, DW, WW] from dev's side."""
    if sum(penta) == 0:
        return 0.0
    pairs, pdf, pdf0, pdf1 = _model(penta, elo0, elo1)
    return pairs * sum(p * (math.log(pdf1[i][1]) - math.log(pdf0[i][1])) for i, (_, p) in enumerate(pdf))


def logistic_elo(score: float) -> float:
    score = min(max(score, 1e-3), 1 - 1e-3)
    return -400 * math.log10(1 / score - 1)


def elo(penta: list[int]) -> tuple[float, float, float] | None:
    """Elo with its 95% interval from the pairs (normal quantile, OpenBench takes Student's t, the same past a few
    dozen pairs)."""
    pairs = sum(penta)
    if pairs < 2:
        return None
    mu = sum(i / 4 * n for i, n in enumerate(penta)) / pairs
    var = sum((i / 4 - mu) ** 2 * n for i, n in enumerate(penta)) / pairs
    margin = 1.959964 * math.sqrt(var / pairs)
    return logistic_elo(mu - margin), logistic_elo(mu), logistic_elo(mu + margin)


def _walk(x: float, lower: float, upper: float, drift: float, variance: float) -> tuple[float, float]:
    """(chance of hitting upper first, expected steps to hit either) for a Brownian motion from x."""
    if variance <= 0:
        return (1.0 if drift > 0 else 0.0), math.inf
    k = 2 * drift / variance
    if abs(k * (upper - lower)) < 1e-6:
        return (x - lower) / (upper - lower), (x - lower) * (upper - x) / variance
    # exp of a large exponent overflows, it means the far bound is out of reach
    try:
        p_upper = (1 - math.exp(-k * (x - lower))) / (1 - math.exp(-k * (upper - lower)))
    except OverflowError:
        p_upper = 1.0 if k > 0 else 0.0
    p_upper = min(max(p_upper, 0.0), 1.0)
    steps = (p_upper * (upper - x) + (1 - p_upper) * (lower - x)) / drift
    return p_upper, max(steps, 0.0)


def project(penta: list[int], elo0: float, elo1: float, lower: float, upper: float) -> dict | None:
    """Where the SPRT is heading: the LLR's drift & spread per pair, the chance it passes and the pairs it has left,
    as things stand and if dev truly is elo0 or elo1."""
    if sum(penta) < 10 or sum(1 for n in penta if n) < 2:
        return None
    pairs, pdf, pdf0, pdf1 = _model(penta, elo0, elo1)
    steps = [math.log(pdf1[i][1]) - math.log(pdf0[i][1]) for i in range(5)]
    now = pairs * sum(p * steps[i] for i, (_, p) in enumerate(pdf))
    out = {"steps": steps}
    for name, probabilities in (("current", [p for _, p in pdf]), ("h0", [p for _, p in pdf0]), ("h1", [p for _, p in pdf1])):
        drift = sum(p * s for p, s in zip(probabilities, steps))
        variance = sum(p * (s - drift) ** 2 for p, s in zip(probabilities, steps))
        p_pass, remaining = _walk(now, lower, upper, drift, variance)
        out[name] = {"drift": drift, "sd": math.sqrt(variance), "pass": p_pass,
                     "pairs": None if math.isinf(remaining) else remaining}
    return out
