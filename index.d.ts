
type Destination = {
  tif?: string, // Specify output tif
  png?: string, // Specify output png
}

type ClipOptions = {
  geojson: GeoJSON,
  ration?: Number, // Specify the ratio of length to width
  minxHeight?: Number, // Specify minimum width
}

type ClipResult = {
  minX: Number, // top left X
  minY: Number, // top left Y
  maxX: Number, // bottom right X
  maxY: Number, // bottom right Y
  length: Number, // pix
  width: Number, // pix
  resolution: Number,
}

/**
 * clip tif using gdal
 * @param {String} src Specify input tif
 * @param {Destination} dst Configuring the Output Path
 * @param {ClipOptions} options clip options
 */
export function clip(src: string, dst: Destination, options: ClipOptions): Promise<ClipResult>;