export interface Cache {
    get?: (key: string) => Promise<any> | undefined | any
    set?: (key: string, value: any) => void | Promise<void>
    has: (key: string) => boolean | Promise<boolean>
    load: () => void | Promise<void>,
    write: () => void | Promise<void>,
    getAll?: () => Promise<any> | undefined | any,
    delete?: (key: string) => void | Promise<void>,
    findByField?: (key: string, value: any) => Promise<any> | undefined | any,
}

export const noCache: Cache = {
    get(key: string): any | undefined {
        return undefined
    },
    set(key: string, value: any): void {

    },
    has(key: string): boolean {
        return false
    },
    load() {
    },
    write() {
    },
}