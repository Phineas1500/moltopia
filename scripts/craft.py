#!/usr/bin/env python3
"""
Crafting script for Moltopia - uses spaCy for semantic item combination.
Called by the Node.js server to determine craft results.

Usage: python3 craft.py <word1> <word2>
Output: The resulting word, or empty string if no valid combination
"""

import sys
import spacy

# Load model (cached after first load)
try:
    nlp = spacy.load("en_core_web_lg")
except OSError:
    print("", file=sys.stdout)
    sys.exit(0)

# Words to avoid as results
BORING_WORDS = {
    "thing", "object", "item", "matter", "substance", "element", "material",
    "concept", "idea", "category", "state", "result", "effect", "cause",
    "force", "energy", "power", "time", "place", "space", "gas", "liquid",
    "solid", "form", "way", "usage", "example", "reason", "type", "part",
    "combination", "mixture", "blend", "mix", "compound"
}

def get_candidates(w1, w2, strict=True):
    """Find semantic matches for w1 + w2 combination."""
    v1 = nlp(w1).vector
    v2 = nlp(w2).vector
    target = v1 + v2

    # Get neighbors
    ms = nlp.vocab.vectors.most_similar(target.reshape(1, -1), n=100)

    candidates = []
    seen_lemmas = {nlp(w1)[0].lemma_.lower(), nlp(w2)[0].lemma_.lower()}

    for word_hash in ms[0][0]:
        word_string = nlp.vocab.strings[word_hash]
        token = nlp(word_string)[0]

        lemma = token.lemma_.lower()

        # Filters
        if not token.is_alpha:
            continue
        if token.is_stop:
            continue
        if lemma in seen_lemmas:
            continue
        if lemma in BORING_WORDS:
            continue
        if token.pos_ not in ["NOUN", "PROPN"]:
            continue
        if not token.has_vector:
            continue

        # Avoid synonyms
        sim_w1 = token.similarity(nlp(w1))
        sim_w2 = token.similarity(nlp(w2))

        threshold = 0.85 if strict else 0.95

        if sim_w1 > threshold or sim_w2 > threshold:
            continue

        candidates.append(lemma)
        seen_lemmas.add(lemma)

        if len(candidates) >= 5:
            break

    return candidates

def craft(w1, w2):
    """Main crafting function."""
    # Try strict search first
    results = get_candidates(w1, w2, strict=True)

    # Fallback to loose search
    if not results:
        results = get_candidates(w1, w2, strict=False)

    if results:
        return results[0]

    return None

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("")
        sys.exit(0)

    word1 = sys.argv[1].lower()
    word2 = sys.argv[2].lower()

    result = craft(word1, word2)

    if result:
        print(result)
    else:
        print("")
