import spacy
import sys
import json
import os

# --- 0. SETUP ---
print("Loading semantic model... (this takes a moment)")
try:
    nlp = spacy.load("en_core_web_lg")
except OSError:
    print("❌ Error: Model 'en_core_web_lg' not found.")
    print("Run this command to fix it: python -m spacy download en_core_web_lg")
    sys.exit(1)

SAVE_FILE = "inventory.json"

# --- 1. CONFIGURATION ---

# Hardcoded "Genesis" recipes to bypass vector limitations
GENESIS_RECIPES = {
    frozenset(["fire", "water"]): "steam",
    frozenset(["fire", "earth"]): "lava",
    frozenset(["fire", "wind"]): "smoke",
    frozenset(["water", "earth"]): "mud",
    frozenset(["water", "wind"]): "rain",
    frozenset(["earth", "wind"]): "dust",
}

# Words to ignore (Generic/Abstract)
BORING_WORDS = {
    "thing", "object", "item", "matter", "substance", "element", "material",
    "concept", "idea", "category", "state", "result", "effect", "cause", 
    "force", "energy", "power", "time", "place", "space", "gas", "liquid", 
    "solid", "form", "way", "usage", "example", "reason", "type", "part"
}

# --- 2. ENGINE ---

def get_candidates(w1, w2, strict=True):
    """
    Finds the best semantic match for w1 + w2.
    Returns a list of LEMMAS (root words) to prevent duplicates.
    """
    v1 = nlp(w1).vector
    v2 = nlp(w2).vector
    target = v1 + v2
    
    # Get neighbors (Top 100)
    ms = nlp.vocab.vectors.most_similar(target.reshape(1, -1), n=100)
    
    candidates = []
    # Input lemmas to avoid returning the parents (e.g. Fire + Water != Fire)
    seen_lemmas = {nlp(w1)[0].lemma_.lower(), nlp(w2)[0].lemma_.lower()}
    
    for word_hash in ms[0][0]:
        word_string = nlp.vocab.strings[word_hash]
        token = nlp(word_string)[0]
        
        # --- CRITICAL CHANGE: USE LEMMA ---
        # This turns "Wires" -> "wire", "Storms" -> "storm"
        lemma = token.lemma_.lower()
        
        # --- FILTERS ---
        if not token.is_alpha: continue
        if token.is_stop: continue
        if lemma in seen_lemmas: continue
        if lemma in BORING_WORDS: continue
        if token.pos_ not in ["NOUN", "PROPN"]: continue
        
        # --- REMOVED PROBABILITY CHECK ---
        # Rare words like 'Obsidian' are now allowed.

        # --- SYNONYM KILLER ---
        if not token.has_vector: continue # Prevent crash
        
        sim_w1 = token.similarity(nlp(w1))
        sim_w2 = token.similarity(nlp(w2))
        
        # Strict mode bans synonyms (similarity > 0.85)
        # Loose mode allows them (similarity > 0.95)
        threshold = 0.85 if strict else 0.95
        
        if sim_w1 > threshold or sim_w2 > threshold:
            continue
            
        candidates.append(lemma)
        seen_lemmas.add(lemma)
        
        if len(candidates) >= 5: break
            
    return candidates

def craft_smart(w1, w2, current_inventory):
    # 1. Genesis Check
    key = frozenset([w1, w2])
    if key in GENESIS_RECIPES:
        return GENESIS_RECIPES[key]
    
    # 2. Try STRICT Search (New Concepts)
    results = get_candidates(w1, w2, strict=True)
    
    # 3. Fallback: Try LOOSE Search (Synonyms/Related)
    if not results:
        results = get_candidates(w1, w2, strict=False)
        
    # 4. Inventory Check (Prevent Duplicates)
    for lemma in results:
        if lemma not in current_inventory:
            return lemma # Return the first valid new item

    return None

# --- 3. SAVE SYSTEM ---

def load_game():
    if os.path.exists(SAVE_FILE):
        with open(SAVE_FILE, "r") as f:
            data = json.load(f)
            return set(data)
    return {"earth", "fire", "water", "wind"}

def save_game(inventory):
    with open(SAVE_FILE, "w") as f:
        json.dump(list(inventory), f)
    print("💾 Game Saved!")

# --- 4. MAIN LOOP ---

def main():
    print("\n✨ WELCOME TO TERMINAL CRAFT (FINAL) ✨")
    print("Type 'save' to save, 'exit' to quit.")
    
    inventory = load_game()
    
    while True:
        # Display Inventory
        print("\n" + "="*50)
        items = sorted(list(inventory))
        print(f"🎒 INVENTORY ({len(inventory)}):")
        for i in range(0, len(items), 5):
            print(", ".join(items[i:i+5]))
        print("="*50)
        
        try:
            # --- INPUT HELPER FUNCTION ---
            def get_valid_item(prompt_text):
                while True:
                    raw_in = input(prompt_text).strip()
                    if raw_in == "exit": return "exit"
                    if raw_in == "save": return "save"
                    
                    # 1. Try Exact Match (e.g. "lightning")
                    if raw_in in inventory:
                        return raw_in
                        
                    # 2. Try Lemma Match (e.g. "winds" -> "wind")
                    lemma = nlp(raw_in)[0].lemma_.lower()
                    if lemma in inventory:
                        return lemma
                        
                    print(f"❌ You don't have '{raw_in}'! (Try checking your spelling)")
                    # Loop back to ask again
            
            # --- GET ELEMENT 1 ---
            i1 = get_valid_item("Element 1: ")
            if i1 == "exit": break
            if i1 == "save": 
                save_game(inventory)
                continue
            
            # --- GET ELEMENT 2 ---
            i2 = get_valid_item("Element 2: ")
            if i2 == "exit": break
            if i2 == "save":
                save_game(inventory)
                continue
                
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"⚠️ Error: {e}")
            continue
            
        print(f"⚗️  Combining {i1} + {i2}...")
        
        new_item = craft_smart(i1, i2, inventory)
        
        if new_item:
            print(f"🎉 DISCOVERY: {new_item.upper()}")
            inventory.add(new_item)
        else:
            print("💨 No new discovery found (Try different elements!)")

if __name__ == "__main__":
    main()