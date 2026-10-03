/**
 * Just enough XML-RPC for `changelog_last_serial()` and `changelog_since_serial(int)`: integers,
 * strings, booleans, nil and arrays. A dependency for two method calls whose whole grammar fits
 * on this page would be a dependency to keep current forever.
 */
export type XmlRpcValue = string | number | boolean | null | XmlRpcValue[] | {[key: string]: XmlRpcValue}

export function encodeMethodCall(method: string, params: (number | string)[]): string {
    const encoded = params.map(param => `<param><value>${encodeValue(param)}</value></param>`).join('')
    return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${encoded}</params></methodCall>`
}

function encodeValue(value: number | string): string {
    if (typeof value === 'number') {
        if (!Number.isInteger(value)) throw new Error(`xml-rpc: ${value} is not an integer`)
        return `<int>${value}</int>`
    }
    return `<string>${escapeXml(value)}</string>`
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Unwraps `<methodResponse>`, raising a `<fault>` as an Error. */
export function decodeMethodResponse(xml: string): XmlRpcValue {
    const root = parseXml(xml)
    const response = findChild(root, 'methodResponse')
    if (!response) throw new Error('xml-rpc: response has no <methodResponse>')

    const fault = findChild(response, 'fault')
    if (fault) {
        const value = findChild(fault, 'value')
        const decoded = value ? decodeValue(value) : null
        const message =
            decoded && typeof decoded === 'object' && !Array.isArray(decoded)
                ? `${String(decoded.faultCode ?? '?')}: ${String(decoded.faultString ?? '')}`
                : JSON.stringify(decoded)
        throw new Error(`xml-rpc fault ${message}`)
    }

    const params = findChild(response, 'params')
    const param = params ? findChild(params, 'param') : undefined
    const value = param ? findChild(param, 'value') : undefined
    if (!value) throw new Error('xml-rpc: response carries no value')
    return decodeValue(value)
}

interface XmlNode {
    name: string
    children: XmlNode[]
    text: string
}

function findChild(node: XmlNode, name: string): XmlNode | undefined {
    return node.children.find(child => child.name === name)
}

function decodeValue(node: XmlNode): XmlRpcValue {
    const typed = node.children[0]
    // `<value>text</value>` with no type tag is a string, per the spec.
    if (!typed) return node.text
    switch (typed.name) {
        case 'string':
            return typed.text
        case 'int':
        case 'i4':
        case 'i8': {
            const parsed = Number.parseInt(typed.text.trim(), 10)
            if (!Number.isFinite(parsed)) throw new Error(`xml-rpc: "${typed.text}" is not an integer`)
            return parsed
        }
        case 'double': {
            const parsed = Number.parseFloat(typed.text.trim())
            if (!Number.isFinite(parsed)) throw new Error(`xml-rpc: "${typed.text}" is not a double`)
            return parsed
        }
        case 'boolean':
            return typed.text.trim() === '1'
        case 'nil':
            return null
        case 'array': {
            const data = findChild(typed, 'data')
            return (data?.children ?? []).filter(child => child.name === 'value').map(decodeValue)
        }
        case 'struct': {
            const out: {[key: string]: XmlRpcValue} = {}
            for (const member of typed.children) {
                if (member.name !== 'member') continue
                const name = findChild(member, 'name')
                const value = findChild(member, 'value')
                if (name && value) out[name.text] = decodeValue(value)
            }
            return out
        }
        default:
            throw new Error(`xml-rpc: unsupported value type <${typed.name}>`)
    }
}

/**
 * A stack parser for the subset of XML an XML-RPC response is: elements, text, entities. No
 * attributes are read (XML-RPC has none), and namespaces cannot occur.
 */
function parseXml(xml: string): XmlNode {
    const root: XmlNode = {name: '#root', children: [], text: ''}
    const stack: XmlNode[] = [root]
    let i = 0

    const top = (): XmlNode => stack[stack.length - 1]!

    while (i < xml.length) {
        const lt = xml.indexOf('<', i)
        if (lt === -1) {
            top().text += decodeEntities(xml.slice(i))
            break
        }
        if (lt > i) top().text += decodeEntities(xml.slice(i, lt))

        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt)
            i = end === -1 ? xml.length : end + 3
            continue
        }
        if (xml.startsWith('<![CDATA[', lt)) {
            const end = xml.indexOf(']]>', lt)
            if (end === -1) throw new Error('xml-rpc: unterminated CDATA section')
            top().text += xml.slice(lt + 9, end)
            i = end + 3
            continue
        }

        const gt = xml.indexOf('>', lt)
        if (gt === -1) throw new Error('xml-rpc: unterminated tag')
        let inner = xml.slice(lt + 1, gt)
        i = gt + 1

        // `<?xml ...?>`, `<!DOCTYPE ...>`: not elements.
        if (inner.startsWith('?') || inner.startsWith('!')) continue

        if (inner.startsWith('/')) {
            const name = inner.slice(1).trim()
            if (stack.length < 2 || top().name !== name) {
                throw new Error(`xml-rpc: unexpected </${name}>`)
            }
            stack.pop()
            continue
        }

        const selfClosing = inner.endsWith('/')
        if (selfClosing) inner = inner.slice(0, -1)
        const name = inner.trim().split(/[\s/]/, 1)[0] ?? ''
        if (!name) throw new Error('xml-rpc: tag with no name')

        const node: XmlNode = {name, children: [], text: ''}
        top().children.push(node)
        if (!selfClosing) stack.push(node)
    }

    if (stack.length !== 1) throw new Error(`xml-rpc: unclosed <${top().name}>`)
    return root
}

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}

function decodeEntities(text: string): string {
    if (!text.includes('&')) return text
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
            return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
        }
        if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
        return ENTITIES[body] ?? match
    })
}
