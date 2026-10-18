# -*- coding: utf-8 -*-
"""
wordflower_gen.py -- find Word Flower puzzles in a Hunspell dictionary.

An editor's starting point, not a publisher: it proposes flowers with their
complete word lists, and a person still reads every list before it goes out
(the lists are only as fair as the dictionary, and dictionaries carry
obscure and unpleasant words).

    python tools/wordflower_gen.py DICT_DIR [--count 10] [--start 2026-10-10]
           [--min 25] [--max 50] [--out puzzles]

DICT_DIR holds en_US.dic and en_US.aff (any Hunspell English dictionary;
the SCOWL-based one shipped with LibreOffice, Firefox or Adobe Reader works).

How a flower is chosen:
  * a PANGRAM SEED: a word with exactly seven distinct letters, none of them
    S -- an S flower accepts every plural and doubles the list for nothing;
  * a CENTRE among those seven letters that leaves a word list of a playable
    size (the GDD wants 23-60; the default aims a little inside that);
  * words are four letters or more, lower case in the dictionary (so no
    proper nouns or abbreviations), suffix forms included -- the GDD counts
    "evacuate" and "evacuated" as two words -- prefix forms left out, since
    they mostly produce words nobody would think of ("reanoint");
  * nothing from BLOCK, the words a family newspaper does not print.
"""
import argparse, io, os, random, re, json, datetime

MIN_LEN = 4

# Words that must never be an answer. Deliberately broad: a missing fair word
# costs a reader a point; a printed slur costs the paper far more.
BLOCK = set('''
anal anus arse arsed arses bastard bastards bitch bitched bitches bitching bitchy
bollock bollocks boner boob boobs booby boozed bugger buggered butt butts clit
cock cocks coon coons crap crapped crapping craps crappy cunt cunts damn damned
damning damns dick dicks dildo dildos dyke dykes fag fags faggot fart farted
farting farts fuck fucked fucker fuckers fucking fucks gook gooks hell hells
homo homos honky horny hump humped humping humps jism jizz kike kikes knob
knobs lesbo nigga nigger niggers nipple nipples orgasm orgasms paki penis
penises piss pissed pisses pissing poof poofs poon porn porno prick pricks
pube pubes pussy queer queers rape raped rapes raping rapist retard retarded
rimming screw scrot scrotum semen sexy shag shagged shit shits shitted shitting
shitty skank slag slut sluts smut snatch spic spics spunk tard tits titty
tosser turd turds twat twats vagina vaginal wank wanked wanker wanking whore
whores wop wops bimbo bimbos tranny trannies negro negroes gypped gyp gyps
spaz spastic midget midgets lynch lynched lynching nazi nazis chink chinks
octoroon octoroons quadroon quadroons
'''.split())


# Words the dictionary allows that no reader would think to try, or would be
# annoyed to be told they missed: abbreviations it stores in lower case,
# archaic and technical forms, and inflections nobody uses. Grown by reading
# the generated lists -- an editor's call each time, recorded here so the
# next run makes the same call.
EXCLUDE = set('''
ketch kine kith knick tektite betake betaken katakana lank aliyah dilly hallo
halloo holdall ilia illy lido lilo loll lolly dido diploid hoodoo inion lino
lollop phonon pillion pinion pinon pion pooh poop poplin anion anon bairn bani
bona boron nabob orion roan rowan wain wanna wino hereunder hued hundreder
hurter hutted teether theed thereunder thunderer truther untruth corr runty
rutty tron troy tyro acct actinic catenate ceca cetacean cine incant annuitant
annum manumit mouton muon nonunion nutation tutti unmount atilt calla dicta
iliac ital tali wadi williwaw eyer jeerer jejune jenny jerry journeyer neurone
oner roue nonvocal vaccinia vaccinial viii villi vivo vocalic chichi chine
chit chitin tench titch abbr barrio cont tony tunny anti babbitt inti tibiae
tine titanate titian licit twilit twill
'''.split())


def read_aff(path):
    rules = {}           # flag -> (kind, cross, [(strip, add, cond_regex)])
    with io.open(path, encoding='latin-1') as f:
        lines = [l.rstrip('\n') for l in f]
    i = 0
    while i < len(lines):
        parts = lines[i].split()
        if len(parts) == 4 and parts[0] in ('PFX', 'SFX') and parts[2] in ('Y', 'N'):
            kind, flag, cross, n = parts[0], parts[1], parts[2] == 'Y', int(parts[3])
            body = []
            for j in range(1, n + 1):
                r = lines[i + j].split()
                strip = '' if r[2] == '0' else r[2]
                add = '' if r[3] == '0' else r[3].split('/')[0]
                cond = r[4] if len(r) > 4 else '.'
                body.append((strip, add, re.compile(
                    (cond + '$') if kind == 'SFX' else ('^' + cond))))
            rules[flag] = (kind, cross, body)
            i += n + 1
            continue
        i += 1
    return rules


def read_words(dic_dir):
    rules = read_aff(os.path.join(dic_dir, 'en_US.aff'))
    words = set()
    with io.open(os.path.join(dic_dir, 'en_US.dic'), encoding='latin-1') as f:
        next(f)                                    # the entry count
        for line in f:
            line = line.strip()
            if not line:
                continue
            stem, _, flags = line.partition('/')
            # lower case only: a capital means a name or an abbreviation
            if not re.fullmatch(r'[a-z]+', stem):
                continue
            words.add(stem)
            for fl in flags:
                rule = rules.get(fl)
                if not rule or rule[0] != 'SFX':
                    continue
                for strip, add, cond in rule[2]:
                    if not cond.search(stem):
                        continue
                    if strip and not stem.endswith(strip):
                        continue
                    w = (stem[:-len(strip)] if strip else stem) + add
                    if re.fullmatch(r'[a-z]+', w):
                        words.add(w)
    return {w for w in words if len(w) >= MIN_LEN and w not in BLOCK}


def build(words, count, lo, hi, seed, pangram_seeds=None):
    rng = random.Random(seed)
    by_letters = {}
    for w in words:
        by_letters.setdefault(frozenset(w), []).append(w)
    if pangram_seeds:
        # the editor's own choice of pangrams, in the order given
        seeds = [frozenset(p.lower()) for p in pangram_seeds if len(set(p.lower())) == 7]
    else:
        # flower letter sets: exactly seven distinct letters, no S, made by
        # a word that is not itself obscure-looking (at most 9 letters)
        seeds = sorted({frozenset(w) for w in words
                        if len(set(w)) == 7 and 's' not in w and len(w) <= 9},
                       key=lambda s: ''.join(sorted(s)))
        rng.shuffle(seeds)
    out, used = [], set()
    for letters in seeds:
        if len(out) >= count:
            break
        key = ''.join(sorted(letters))
        if key in used:
            continue
        # every word that uses only these letters
        fits = sorted(w for subset, ws in by_letters.items() if subset <= letters for w in ws)
        options = []
        for c in sorted(letters):
            ws = [w for w in fits if c in w]
            pangrams = [w for w in ws if set(w) == letters]
            if lo <= len(ws) <= hi and pangrams:
                options.append((c, ws, pangrams))
        if not options:
            continue
        # aim for the middle of the range
        mid = (lo + hi) / 2
        c, ws, pangrams = min(options, key=lambda o: abs(len(o[1]) - mid))
        petals = [l for l in sorted(letters) if l != c]
        rng.shuffle(petals)
        used.add(key)
        out.append({'center': c.upper(), 'petals': [p.upper() for p in petals],
                    'words': [w.upper() for w in ws],
                    'pangrams': [w.upper() for w in pangrams]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dict_dir')
    ap.add_argument('--count', type=int, default=10)
    ap.add_argument('--start', default=datetime.date.today().isoformat())
    ap.add_argument('--min', type=int, default=25)
    ap.add_argument('--max', type=int, default=50)
    ap.add_argument('--seed', default='word-flower')
    ap.add_argument('--pangrams', default='',
                    help='comma-separated seed words, each with exactly 7 distinct letters')
    ap.add_argument('--out', default='')
    a = ap.parse_args()

    words = read_words(a.dict_dir) - EXCLUDE
    print(len(words), 'words of', MIN_LEN, '+ letters')
    seeds = [p.strip() for p in a.pangrams.split(',') if p.strip()]
    flowers = build(words, a.count, a.min, a.max, a.seed, seeds or None)
    day = datetime.date.fromisoformat(a.start)
    for k, f in enumerate(flowers):
        iso = (day + datetime.timedelta(days=k)).isoformat()
        f.update({'schema': 1, 'id': 'wordflower-' + iso, 'title': 'Word Flower', 'date': iso})
        print('\n%s  centre %s  petals %s  %d words  pangrams %s' %
              (iso, f['center'], ''.join(f['petals']), len(f['words']), ', '.join(f['pangrams'])))
        print('   ' + ' '.join(f['words']))
        if a.out:
            payload = {k2: f[k2] for k2 in ('schema', 'id', 'title', 'date', 'center', 'petals', 'words')}
            payload.update({'author': '', 'editor': ''})
            with io.open(os.path.join(a.out, f['id'] + '.json'), 'w', encoding='utf-8', newline='\n') as fh:
                json.dump(payload, fh, indent=2)
                fh.write('\n')


if __name__ == '__main__':
    main()
