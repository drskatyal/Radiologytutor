// Minimal surface of dcmjs used by the sketch exporter (the package ships no types).
declare module "dcmjs" {
  type Dataset = Record<string, unknown>;
  interface DicomDictInstance {
    dict: Dataset;
    meta: Dataset;
    write(options?: Record<string, unknown>): ArrayBuffer;
  }
  const dcmjs: {
    data: {
      DicomMetaDictionary: {
        denaturalizeDataset(dataset: Dataset): Dataset;
        naturalizeDataset(dataset: Dataset): Dataset;
      };
      DicomDict: new (meta: Dataset) => DicomDictInstance;
      DicomMessage: {
        readFile(buffer: ArrayBuffer, options?: Record<string, unknown>): { dict: Dataset; meta: Dataset };
      };
    };
  };
  export default dcmjs;
}
