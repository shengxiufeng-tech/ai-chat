// word-extractor 没有自带类型声明，这里只声明用到的部分
declare module 'word-extractor' {
  interface ExtractedDocument {
    getBody(): string;
    getFootnotes?(): string;
    getEndnotes?(): string;
    getHeaders?(): string;
  }
  export default class WordExtractor {
    extract(input: string | Buffer): Promise<ExtractedDocument>;
  }
}
