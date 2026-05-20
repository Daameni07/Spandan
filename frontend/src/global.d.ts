declare global {
  interface Window {
    webkitSpeechRecognition: any;
  }
}

declare module 'file-saver' {
  export function saveAs(
    data: BlobPart,
    filename: string,
    options?: { autoBom?: boolean }
  ): void;
}

export {};