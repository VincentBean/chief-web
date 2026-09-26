/**
 * Catches a transcript in a language the operator does not speak. With a
 * second language set, the model detects the language per utterance, and on a
 * short or noisy clip it picks the wrong one: Dutch comes back as Icelandic
 * ("Men við dyrir að…") or Spanish ("¿Que no los hagan…?"). OpenRouter only
 * returns the text, so this judges the text: a letter neither language
 * writes, or more common words of another language than of the operator's.
 */

/** Letters beyond a–z each language writes, loanwords included (café, ideeën, naïve). */
const LETTERS: Readonly<Record<string, string>> = {
  nl: 'áéíóúàèëïöüâêîôûç',
  en: 'éèëïç',
  de: 'äöüßé',
  fr: 'àâæçéèêëîïôœùûüÿ',
  es: 'áéíóúüñ¿¡',
  it: 'àèéìíîòóùú',
  pt: 'áâãàçéêíóôõú',
};

/**
 * Frequent function words. A word two languages share is ignored ("de", "en",
 * "no"): only a word of another language that none of the operator's use counts.
 */
const WORDS: Readonly<Record<string, string>> = {
  nl: 'de het een en van in is dat die op te ik je jij niet met voor maar ook wat er zijn naar dan als nog wel kan hij zij ze we wij dit om uit aan bij of nu ja nee al moet wil gaat hebben heb mijn onze dus daar hier hoe waarom welke zou kunnen maak graag',
  en: 'the a an and of in is that this it to i you not with for but also what there are was be can he she we they on at or no yes my our so here how why which would could please do does',
  de: 'der die das und ist nicht ich du mit für aber auch was sind ein eine zu auf wir sie es bitte wie warum welche kann noch nur schon oder',
  fr: 'le la les et est une un pas je tu il elle nous vous avec pour mais aussi que qui dans sur ce ça très oui non',
  es: 'el la los las y es que una un no yo tú él ella con para pero también qué por del muy sí esto eso hay',
  it: 'il lo la gli le e è che una un non io tu lui lei con per ma anche cosa sono della questo',
  pt: 'o a os as e é que uma um não eu tu ele ela com para mas também por do da isso muito',
  is: 'og að við ég er það ekki en hann hún með fyrir sem um var hefur',
  af: 'ek jy nie baie hulle julle sal ons kan wees gaan dit',
  sv: 'och är att jag du inte med för men också vad det som på',
  da: 'og er at jeg du ikke med for men også hvad det som på',
  no: 'og er at jeg du ikke med for men også hva det som på',
};

const WORD_SETS = Object.fromEntries(Object.entries(WORDS).map(([code, words]) => [code, new Set(words.split(' '))]));

/** More words of one other language than this, and more than of the operator's, is a wrong guess. */
const MIN_FOREIGN_WORDS = 2;

/**
 * True when `text` is plainly not in any of `languages` (ISO 639-1). A
 * language this module has no letters for makes it trust the model: false.
 */
export function inOtherLanguage(text: string, languages: readonly string[]): boolean {
  if (languages.length === 0 || languages.some((code) => LETTERS[code] === undefined)) return false;

  const allowed = new Set(languages.flatMap((code) => [...(LETTERS[code] ?? '')]));
  for (const char of text.toLowerCase()) {
    if (/[a-z]/.test(char)) continue;
    // Any other letter, and Spanish's opening marks, which are not letters.
    if ((/\p{L}/u.test(char) || char === '¿' || char === '¡') && !allowed.has(char)) return true;
  }

  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const own = new Set(languages.flatMap((code) => [...(WORD_SETS[code] ?? [])]));
  const ownCount = words.filter((word) => own.has(word)).length;
  for (const [code, set] of Object.entries(WORD_SETS)) {
    if (languages.includes(code)) continue;
    const foreign = words.filter((word) => set.has(word) && !own.has(word)).length;
    if (foreign >= MIN_FOREIGN_WORDS && foreign > ownCount) return true;
  }
  return false;
}
