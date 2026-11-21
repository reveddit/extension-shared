// Synced from the shared source (see shared.json): change it there, not here.
//
// The report settings, shared.json's modules.reports: what's wrong with them,
// their defaults, and the part the report page's script gets. Plain JS with no
// side effects, so the page's build, the handler and node's test runner share it.

// A report's types, as the form's choices send them
export const TYPES = ['bug', 'feature', 'question', 'other']
// The hourly caps the site's counter keeps (report-counts.js): from one sender,
// kept from everyone together, and filed as issues from everyone together
export const CAPS = ['perSender', 'keptPerHour', 'filedPerHour']
const MESSAGES = ['empty', 'sent']

const DEFAULTS = {
    // an issue's title starts with its type's name
    typeNames: { bug: 'Problem', feature: 'Idea', question: 'Question', other: 'Feedback' },
    // what the form says when the message is empty, and once a report is sent
    messages: { empty: 'Please say what happened.', sent: 'Sent. Thank you!' },
    // the inbox's badge
    accent: '#536471',
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const isRepo = v => typeof v === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v)
// an object with some of `keys`, each value passing `ok`
const someOf = (v, keys, ok) => isObject(v) && Object.entries(v).every(([k, x]) => keys.includes(k) && ok(x))

// Each setting, with what makes it wrong ('' when it's fine)
const RULES = {
    // the site's own address: reports come only from its form (and a local preview's)
    origin: v =>
        typeof v === 'string' && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)
            ? ''
            : "origin must be the site's address, like https://example.com, with no path or trailing slash",
    // the extension's name: in each issue, the inbox, and the form's details line
    product: v => (isText(v) ? '' : "product must be the extension's name"),
    // whose username the form asks for, as each issue names it ("forum user: `name`")
    userLabel: v => (isText(v) ? '' : 'userLabel must say whose username the form asks for, like "forum user"'),
    // the public repository, whose issue form "Post publicly on GitHub" opens
    publicRepo: v => (isRepo(v) ? '' : 'publicRepo must be the public GitHub repository, as owner/name'),
    // the private repository whose workflow files each report as an issue
    privateRepo: v => (isRepo(v) ? '' : 'privateRepo must be the private GitHub repository reports are filed in, as owner/name'),
    // what the log's ids (#123) name, for the form's "where post ids are now hidden"
    ids: v => (typeof v === 'string' && /^[a-z]+$/.test(v) ? '' : 'ids must be the word for what an id names, like "post"'),
    typeNames: v => (someOf(v, TYPES, isText) ? '' : `typeNames must name some of the types: ${TYPES.join(', ')}`),
    messages: v => (someOf(v, MESSAGES, isText) ? '' : `messages must give some of these a text: ${MESSAGES.join(', ')}`),
    caps: v =>
        someOf(v, CAPS, n => Number.isInteger(n) && n > 0) && CAPS.every(k => k in v)
            ? ''
            : 'caps must be { perSender, keptPerHour, filedPerHour }, each a whole number above 0',
    accent: v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? '' : 'accent must be a color like #1d9bf0'),
}
const REQUIRED = ['origin', 'product', 'userLabel', 'publicRepo', 'privateRepo', 'ids', 'caps']

// What's wrong with a modules.reports object, as a list of sentences
export function settingsProblems(s) {
    if (!isObject(s)) return ['shared.json has no report settings (modules.reports)']
    const problems = []
    for (const key of Object.keys(s)) {
        if (!Object.hasOwn(RULES, key)) problems.push(`unknown setting "${key}"`)
        else if (RULES[key](s[key])) problems.push(RULES[key](s[key]))
    }
    for (const key of REQUIRED) if (!(key in s)) problems.push(`${key} is missing`)
    return problems
}

// The settings with their defaults filled in
export function withDefaults(s) {
    return {
        ...s,
        typeNames: { ...DEFAULTS.typeNames, ...s.typeNames },
        messages: { ...DEFAULTS.messages, ...s.messages },
        accent: s.accent || DEFAULTS.accent,
    }
}

// The settings with their defaults, or an error that says what's wrong with them
export function checkedSettings(s) {
    const problems = settingsProblems(s)
    if (problems.length) throw new Error(`The report settings (shared.json's modules.reports) are wrong: ${problems.join('; ')}.`)
    return withDefaults(s)
}

// What the report page's script needs (feedback-form.js), which the page puts in
// its form's data-settings when it's built. Nothing else from the settings
// reaches the page.
export function formSettings(s) {
    const { product, publicRepo, ids, messages } = checkedSettings(s)
    return { product, publicRepo, ids, messages }
}
