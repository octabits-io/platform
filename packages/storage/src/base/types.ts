// Data types
export interface StorageObject {
  readonly key: string;
  readonly size: number;
}

export interface StorageObjectWithHead extends StorageObject {
  readonly metadata: { readonly [key: string]: string };
  readonly contentType: string;
}

export interface ListObjectsResponse<T extends boolean> {
  readonly continuationToken: string | undefined;
  readonly objects: T extends true ? readonly StorageObjectWithHead[] : readonly StorageObject[];
}

export interface ObjectData {
  readonly data: Buffer;
  readonly size: number;
  readonly contentType: string;
  readonly metadata: Record<string, string>;
  readonly lastModified: string;
}
