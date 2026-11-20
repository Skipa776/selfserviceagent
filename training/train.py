"""Train the CDMForge specialist models (Milestone 2).

One script, run with `npm run train`. It reads data/train/dataset.jsonl (built by
scripts/buildTrainingSet.ts) and writes three files under models/:

  weights.json          what the TypeScript service loads (src/parser/specialist.ts)
  parity-fixtures.json  texts and the probabilities this script computes for them;
                        tests/specialistParity.test.ts checks TypeScript gets the same
  training-report.json  every number docs/RESULTS.md quotes about the specialists

Each "head" is a linear model: a logistic regression over hashed word 1- and
2-grams of the place-masked text (`featureText`, written by the TypeScript
builder: Python never sees a building name). Prediction is a dot product, a temperature, and a softmax. All
thresholds are chosen on the validation split; the held-out split is only
measured, never used to choose anything. Everything here is SYNTHETIC data.
"""

import hashlib
import json
import platform
import re
from pathlib import Path

import numpy as np
import scipy
import sklearn
from scipy import sparse
from scipy.stats import beta
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.model_selection import GroupKFold

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "data/train/dataset.jsonl"
PARITY_INPUTS = ROOT / "data/train/parity-inputs.jsonl"
MODELS = ROOT / "models"

# ── Feature configuration: must equal src/parser/features.ts ────────────────
# The TypeScript loader compares these header values with its own constants and
# turns the specialist off on any mismatch.
DIMENSIONS = 2**16
MAX_TOKENS = 400  # tokens, not characters: tokens are ASCII, so both languages count the same

# ── Training and selection configuration ─────────────────────────────────────
SEED = 20261120
C_GRID = [0.1, 0.3, 1.0, 3.0, 10.0]
TEMPERATURE_GRID = [round(0.5 + 0.05 * i, 2) for i in range(91)]  # 0.50 … 5.00
TARGET_ERROR = 0.05  # on the 95% Clopper-Pearson upper bound, not the point estimate
TAU_FLOOR = 0.5
DECIMALS = 6

# Label order must equal src/vocab/catalog.ts; the TypeScript loader checks it.
HEADS = {
    "service": ["wifi", "wired_network", "vpn", "web_portal", "classroom_av", "unknown"],
    "scope": ["individual", "location", "service_wide", "unknown"],
    "symptom": ["no_connection", "intermittent", "slow", "page_error", "auth_failure", "equipment_unavailable", "unknown"],
    "frustrated": ["false", "true"],
}
REPORT_HEADS = ["service", "scope", "symptom"]


# ── Features ─────────────────────────────────────────────────────────────────

def tokens(text: str) -> list[str]:
    """ASCII-only lowercase, then runs of [a-z0-9]. Non-ASCII characters are never letters here."""
    lowered = re.sub("[A-Z]", lambda m: m.group(0).lower(), text)
    return re.findall("[a-z0-9]+", lowered)[:MAX_TOKENS]


def fnv1a(text: str) -> int:
    """32-bit FNV-1a over UTF-8 bytes."""
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def grams(text: str) -> list[str]:
    t = tokens(text)
    return t + [f"{a} {b}" for a, b in zip(t, t[1:])]


def buckets(text: str) -> list[int]:
    """The sorted, de-duplicated feature buckets of a text (binary presence)."""
    return sorted({fnv1a(g) % DIMENSIONS for g in grams(text)})


def matrix(texts: list[str]) -> sparse.csr_matrix:
    rows, cols = [], []
    for i, text in enumerate(texts):
        for b in buckets(text):
            rows.append(i)
            cols.append(b)
    return sparse.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(texts), DIMENSIONS))


# ── Inference from the EXPORTED (rounded) weights ────────────────────────────
# Thresholds, metrics and parity fixtures all use this, so what is certified is
# exactly what TypeScript will run.

def softmax(z: np.ndarray) -> np.ndarray:
    e = np.exp(z - z.max())
    return e / e.sum()


def predict(model: dict, head: str, text_buckets: list[int], temperature: float) -> np.ndarray:
    h = model["heads"][head]
    logits = np.array(h["bias"], dtype=np.float64)
    for b in text_buckets:
        row = model["rows"].get(str(b))
        if row is not None:
            logits = logits + np.array(row[head], dtype=np.float64)
    return softmax(logits / temperature)


# ── Selection helpers ────────────────────────────────────────────────────────

def cp_upper(errors: int, n: int) -> float:
    """Upper end of the two-sided 95% Clopper-Pearson interval for errors/n."""
    return 1.0 if errors >= n else float(beta.ppf(0.975, errors + 1, n - errors))


def cp_interval(errors: int, n: int) -> list[float]:
    lower = 0.0 if errors == 0 else float(beta.ppf(0.025, errors, n - errors + 1))
    return [round(lower, 4), round(cp_upper(errors, n), 4)]


def lowest_safe_tau(confidences: np.ndarray, eligible: np.ndarray, wrong: np.ndarray) -> float | None:
    """Lowest tau (>= floor) whose accepted rows have a 95% upper error bound <= target."""
    for tau in sorted(set(confidences[eligible & (confidences >= TAU_FLOOR)].tolist())):
        accepted = eligible & (confidences >= tau)
        n = int(accepted.sum())
        if n > 0 and cp_upper(int((wrong & accepted).sum()), n) <= TARGET_ERROR:
            return float(tau)
    return None


def ece(confidences: np.ndarray, correct: np.ndarray, bins: int = 10) -> float:
    """Top-label expected calibration error with equal-mass bins."""
    order = np.argsort(confidences, kind="stable")
    total = 0.0
    for chunk in np.array_split(order, bins):
        if len(chunk):
            total += len(chunk) / len(order) * abs(correct[chunk].mean() - confidences[chunk].mean())
    return round(float(total), 4)


# ── Self-check: the selection math, on cases with known answers ──────────────

def self_check() -> None:
    """Runs before training; a wrong helper would silently move every threshold."""
    assert abs(cp_upper(0, 59) - 0.0606) < 1e-3  # zero errors in 59: the bound is still about 6%
    assert abs(cp_upper(0, 73) - 0.0493) < 1e-3  # the smallest error-free sample that meets 5%
    assert cp_upper(3, 3) == 1.0
    conf = np.array([0.9, 0.8, 0.7, 0.6, 0.55] * 40)
    wrong = np.array([False, False, False, True, True] * 40)
    assert lowest_safe_tau(conf, np.ones(200, dtype=bool), wrong) == 0.7  # 120 rows, 0 errors at >= 0.7
    assert lowest_safe_tau(conf, np.zeros(200, dtype=bool), wrong) is None
    # ECE: equal-mass bins split TIED confidences by row order, so the known-answer
    # cases use distinct confidences. Calibrated at 0.5: about 0. Always wrong at 0.9: about 0.9.
    distinct = 0.5 + np.arange(100) * 1e-6
    assert ece(distinct, np.array([True, False] * 50)) < 1e-3
    assert abs(ece(distinct + 0.4, np.zeros(100, dtype=bool)) - 0.9) < 1e-3
    assert fnv1a("") == 0x811C9DC5 and fnv1a("a") == 0xE40C292C  # published FNV-1a test vectors
    assert tokens("Wi-Fi ÉCOLE caf\u00e9 x2") == ["wi", "fi", "cole", "caf", "x2"]


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    self_check()
    raw = DATASET.read_bytes()
    rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    split = {name: [r for r in rows if r["split"] == name] for name in ("train", "validation", "heldout")}
    train = split["train"]
    x_train = matrix([r["featureText"] for r in train])
    groups = [r["group"] for r in train]

    def label(r: dict, head: str) -> str:
        return ("true" if r["frustrated"] else "false") if head == "frustrated" else r[head]

    # 1. Fit each head; choose C by grouped cross-validation on train only.
    fitted, chosen_c = {}, {}
    for head, labels in HEADS.items():
        y = np.array([labels.index(label(r, head)) for r in train])
        scores = {}
        for c in C_GRID:
            losses = []
            for tr, te in GroupKFold(n_splits=5).split(x_train, y, groups):
                m = LogisticRegression(C=c, max_iter=5000, random_state=SEED).fit(x_train[tr], y[tr])
                losses.append(log_loss(y[te], m.predict_proba(x_train[te]), labels=m.classes_))
            scores[c] = float(np.mean(losses))
        chosen_c[head] = min(scores, key=scores.get)
        fitted[head] = LogisticRegression(C=chosen_c[head], max_iter=5000, random_state=SEED).fit(x_train, y)

    # 2. Export: one weight row per bucket seen in training, rounded.
    seen = sorted(set(x_train.indices.tolist()))
    model = {"heads": {}, "rows": {}}
    for head, labels in HEADS.items():
        m = fitted[head]
        coef, bias = m.coef_, m.intercept_
        if len(labels) == 2:  # binary: sklearn keeps one row; store it as [0, w] so softmax works the same
            coef, bias = np.vstack([np.zeros_like(coef[0]), coef[0]]), np.array([0.0, bias[0]])
        model["heads"][head] = {"labels": labels, "bias": [round(float(v), DECIMALS) for v in bias]}
        for b in seen:
            model["rows"].setdefault(str(b), {})[head] = [round(float(v), DECIMALS) for v in coef[:, b]]

    # 3. Temperatures on validation (grid, deterministic), with the rounded weights.
    val = split["validation"]
    val_buckets = [buckets(r["featureText"]) for r in val]
    for head, labels in HEADS.items():
        y = [labels.index(label(r, head)) for r in val]
        def nll(t: float) -> float:
            return float(np.mean([-np.log(max(predict(model, head, b, t)[yi], 1e-12)) for b, yi in zip(val_buckets, y)]))
        model["heads"][head]["temperature"] = min(TEMPERATURE_GRID, key=nll)

    def assess(subset: list[dict]) -> dict:
        """Per row: predictions, confidences, eligibility and correctness."""
        out = {"pred": {}, "conf": {}, "correct": {}}
        bucket_lists = [buckets(r["featureText"]) for r in subset]
        for head, labels in HEADS.items():
            probs = [predict(model, head, b, model["heads"][head]["temperature"]) for b in bucket_lists]
            out["pred"][head] = [labels[int(np.argmax(p))] for p in probs]
            out["conf"][head] = np.array([float(np.max(p)) for p in probs])
            out["correct"][head] = np.array([p == label(r, head) for p, r in zip(out["pred"][head], subset)])
        out["min_conf"] = np.min([out["conf"][h] for h in REPORT_HEADS], axis=0)
        no_unknown = np.array([all(out["pred"][h][i] != "unknown" for h in REPORT_HEADS) for i in range(len(subset))])
        # The service's own rule: a location scope needs a recognized place, no other scope may carry one.
        consistent = np.array([(out["pred"]["scope"][i] == "location") == (r["location"] != "") for i, r in enumerate(subset)])
        out["eligible"] = no_unknown & consistent
        out["wrong"] = ~np.all([out["correct"][h] for h in REPORT_HEADS], axis=0)
        return out

    # 4. The joint threshold and the frustration threshold, on validation only.
    v = assess(val)
    tau = lowest_safe_tau(v["min_conf"], v["eligible"], v["wrong"])
    frustration_tau = lowest_safe_tau(v["conf"]["frustrated"], np.ones(len(val), dtype=bool), ~v["correct"]["frustrated"])

    model_header = {
        "format": "cdmforge-linear-v1",
        "hash": "fnv1a-32",
        "dimensions": DIMENSIONS,
        "ngrams": [1, 2],
        "maxTokens": MAX_TOKENS,
        "tau": tau,
        "frustrationTau": frustration_tau,
        "targetError": TARGET_ERROR,
        "tauFloor": TAU_FLOOR,
        "seed": SEED,
        "c": chosen_c,
        "datasetSha256": hashlib.sha256(raw).hexdigest(),
        "rows": {name: len(subset) for name, subset in split.items()},
        "versions": {"python": platform.python_version(), "sklearn": sklearn.__version__, "numpy": np.__version__, "scipy": scipy.__version__},
    }
    weights = {"header": model_header, "heads": model["heads"], "rows": model["rows"]}

    # 5. Held-out measurement: nothing below chooses anything.
    report = {"header": model_header, "validation": summary(v, tau), "heldout": summary(assess(split["heldout"]), tau)}
    h = assess(split["heldout"])
    report["heldout"]["frustration"] = frustration_summary(h, frustration_tau)
    report["heldout"]["curve"] = curve(h)
    report["heldout"]["ece"] = {head: ece(h["conf"][head], h["correct"][head]) for head in HEADS}
    report["heldout"]["scopeConfusion"] = confusion(h, split["heldout"])
    report["heldout"]["frustrationVsLexical"] = frustration_vs_lexical(h, split["heldout"], frustration_tau)
    report["topFeatures"] = top_features(model, train)

    MODELS.mkdir(exist_ok=True)
    (MODELS / "weights.json").write_text(json.dumps(weights, separators=(",", ":")) + "\n")
    (MODELS / "training-report.json").write_text(json.dumps(report, indent=2) + "\n")
    (MODELS / "parity-fixtures.json").write_text(json.dumps(parity_fixtures(model, tau, frustration_tau), indent=1) + "\n")
    print(json.dumps({"tau": tau, "frustrationTau": frustration_tau, "c": chosen_c,
                      "temperatures": {k: v2["temperature"] for k, v2 in model["heads"].items()},
                      "validation": report["validation"], "heldout": {k: report["heldout"][k] for k in ("n", "accepted", "coverage", "errors", "selectiveRisk", "selectiveRisk95", "fieldAccuracy", "ece", "frustration", "frustrationVsLexical")}}, indent=1))


def summary(a: dict, tau: float | None) -> dict:
    n = len(a["min_conf"])
    accepted = a["eligible"] & (a["min_conf"] >= (tau if tau is not None else 1.1))
    k = int((a["wrong"] & accepted).sum())
    acc_n = int(accepted.sum())
    return {
        "n": n,
        "accepted": acc_n,
        "coverage": round(acc_n / n, 4),
        "errors": k,
        "selectiveRisk": round(k / acc_n, 4) if acc_n else None,
        "selectiveRisk95": cp_interval(k, acc_n) if acc_n else None,
        "fieldAccuracy": {head: round(float(a["correct"][head].mean()), 4) for head in REPORT_HEADS},
    }


def frustration_summary(a: dict, tau: float | None) -> dict:
    accepted = a["conf"]["frustrated"] >= (tau if tau is not None else 1.1)
    k = int((~a["correct"]["frustrated"] & accepted).sum())
    n = int(accepted.sum())
    return {"against": "generator labels", "accepted": n, "coverage": round(n / len(accepted), 4), "errors": k,
            "risk95": cp_interval(k, n) if n else None}


def frustration_vs_lexical(a: dict, subset: list[dict], tau: float | None) -> dict:
    """Agreement with the generator labels: the head versus today's lexical rule, on the same rows."""
    labels = np.array([r["frustrated"] for r in subset])
    lexical = np.array([r["lexicalFrustrated"] for r in subset])
    head = np.array([p == "true" for p in a["pred"]["frustrated"]])
    accepted = a["conf"]["frustrated"] >= (tau if tau is not None else 1.1)
    return {
        "allRows": {"n": len(subset), "head": int((head == labels).sum()), "lexical": int((lexical == labels).sum())},
        "acceptedRows": {"n": int(accepted.sum()), "head": int((head == labels)[accepted].sum()), "lexical": int((lexical == labels)[accepted].sum())},
    }


def curve(a: dict) -> list[dict]:
    """Risk-coverage: sweep the joint threshold over the eligible rows' confidences."""
    points = []
    for tau in np.quantile(a["min_conf"][a["eligible"]], np.linspace(0, 1, 21)) if a["eligible"].any() else []:
        accepted = a["eligible"] & (a["min_conf"] >= tau)
        n = int(accepted.sum())
        k = int((a["wrong"] & accepted).sum())
        points.append({"tau": round(float(tau), 4), "coverage": round(n / len(accepted), 4), "risk": round(k / n, 4) if n else None})
    return points


def confusion(a: dict, subset: list[dict]) -> dict:
    """Scope confusion, all held-out rows: counts of (expected -> predicted)."""
    counts: dict[str, int] = {}
    for i, r in enumerate(subset):
        key = f"{r['scope']}->{a['pred']['scope'][i]}"
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def top_features(model: dict, train: list[dict], k: int = 6) -> dict:
    """The strongest n-grams per class, for the article and for the masking check (council M2-Q2)."""
    names: dict[int, str] = {}
    for r in train:
        for g in grams(r["featureText"]):
            names.setdefault(fnv1a(g) % DIMENSIONS, g)
    out = {}
    for head in ("service", "symptom"):
        for ci, label_name in enumerate(HEADS[head]):
            ranked = sorted(model["rows"].items(), key=lambda kv: -kv[1][head][ci])[:k]
            out[f"{head}={label_name}"] = [names.get(int(b), "?") for b, _ in ranked]
    return out


def parity_fixtures(model: dict, tau: float | None, frustration_tau: float | None) -> list[dict]:
    """Probabilities for the texts the TypeScript builder chose; TypeScript must reproduce them."""
    inputs = [json.loads(line) for line in PARITY_INPUTS.read_text("utf-8").splitlines() if line.strip()]
    fixtures = []
    for item in inputs:
        text = item["text"]
        b = buckets(item["featureText"])
        probs = {head: predict(model, head, b, model["heads"][head]["temperature"]).tolist() for head in HEADS}
        labels = {head: HEADS[head][int(np.argmax(p))] for head, p in probs.items()}
        min_conf = min(max(probs[h]) for h in REPORT_HEADS)
        confident = tau is not None and min_conf >= tau and all(labels[h] != "unknown" for h in REPORT_HEADS)
        frustration_confident = frustration_tau is not None and max(probs["frustrated"]) >= frustration_tau
        fixtures.append({"text": text, "buckets": b, "probabilities": probs, "labels": labels,
                         "minConfidence": min_conf, "confident": bool(confident), "frustrationConfident": bool(frustration_confident)})
    return fixtures


if __name__ == "__main__":
    main()
