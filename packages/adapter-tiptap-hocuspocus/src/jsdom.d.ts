declare module 'jsdom' {
  export class JSDOM {
    readonly window: Window;

    constructor(html?: string, options?: { readonly contentType?: string });
  }
}
