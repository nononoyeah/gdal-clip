'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const gdal = require('gdal-async');


class Gdal {
  /**
    * gdal裁切影像
    * @param {String} src 原始影像路径
    * @param {Object} dst 裁剪选项
    * @param {String} dst.tif 目标影像输出路径
    * @param {String} dst.png 目标PNG输出路径
    * @param {Object} options 裁剪选项
    * @param {Object} options.geojson 裁剪范围
    * @param {Number} options.ratio 裁剪长宽比
    * @param {Number} options.minxWidth 最小宽度
    */
  async clip(src, dst, options) {
    const { geojson, ratio, minxWidth = 512 } = options;
    const dstPng = dst.png;
    let dstTif = dst.tif;

    let tempTif;

    this._checkGeojson(geojson);

    // if (!src) {
    //   throw new Error('source tif required');
    // }
    if (!fs.existsSync(src)) {
      throw new Error(`${src} is not exists`);
    }
    // const stat = await fs.promises.stat(src);
    // if (!stat.isFile()) {
    //   throw new Error(`${src} is not a file`);
    // }

    if (!dstPng && !dstTif) {
      throw new Error('output file (tif or png) required');
    }


    if (dstTif) {
      const dstTifDir = path.dirname(dstTif);
      if (!fs.existsSync(dstTifDir)) {
        await fs.promises.mkdir(dstTifDir, { recursive: true });
      }
    } else {
      const dir = await fs.promises.mkdtemp(`${os.tmpdir}`);
      tempTif = path.resolve(dir, `./${path.basename(src)}`);
      dstTif = tempTif;
    }

    if (dstPng) {
      const dstPngDir = path.dirname(dstPng);
      if (!fs.existsSync(dstPngDir)) {
        await fs.promises.mkdir(dstPngDir, { recursive: true });
      }
    }

    const srcds = await gdal.openAsync(src);

    try {
      const srcSrs = await srcds.srsAsync;
      const geoTransform = await srcds.geoTransformAsync;
      const rasterSize = await srcds.rasterSizeAsync;
      const resolution = geoTransform[1];
      const extentSrcds = [
        geoTransform[0], // src minX
        geoTransform[3], // src maxY
        geoTransform[0] + rasterSize.x * resolution, // src maxX
        geoTransform[3] - +rasterSize.y * resolution, // src minY
      ];

      const geometry = await gdal.Geometry.fromGeoJsonAsync(geojson);
      const clipSrs = gdal.SpatialReference.fromProj4('+init=epsg:4326');
      if (extentSrcds[0] > 180) {
        const trans = new gdal.CoordinateTransformation(clipSrs, srcSrs);
        await geometry.transformAsync(trans);
      }

      const envelope = await geometry.getEnvelopeAsync();
      const clipExtent = [ envelope.minX, envelope.maxY, envelope.maxX, envelope.minY ];

      let length = parseInt(Math.ceil((clipExtent[2] - clipExtent[0]) / resolution));
      let width = parseInt(Math.ceil((clipExtent[1] - clipExtent[3]) / resolution));

      if (ratio) {
        if (width < minxWidth) {
          width = minxWidth;
          length = parseInt(Math.ceil(width * ratio));
        } else {
          if (length <= width) {
            length = parseInt(Math.ceil(width * ratio));
          } else {
            width = parseInt(Math.floor(length / ratio));
          }
        }
      }

      const centroid = geometry.centroid();
      const extentDstds = [
        centroid.x - length / 2 * resolution,
        centroid.y + width / 2 * resolution,
        centroid.x + length / 2 * resolution,
        centroid.y - width / 2 * resolution,
      ];

      const pix = await this._cululate({
        srcExtent: extentSrcds,
        dstExtent: extentDstds,
        srcResolution: resolution,
        dstLength: length,
        dstWidth: width
      });

      if (pix) {
        const {
          distanceToSrcTopX,
          distanceToSrcTopY,
          distanceToSelfTopX,
          distanceToSelfTopY,
          length,
          width,
        } = pix;

        const tifDriver = gdal.drivers.get('GTiff');
        const pngDriver = gdal.drivers.get('PNG');
        const bandCount = await srcds.bands.countAsync();
        const band1 = await srcds.bands.getAsync(1);
        const datatype = band1.dataType;
        const dstds = await tifDriver.createAsync(dstTif, length, width, bandCount, datatype, null);

        try {
          for (let i = 0; i < bandCount; i++) {
            const data = new Float32Array(new ArrayBuffer(length * width * 4));
            const srcBand = await srcds.bands.getAsync(i + 1);
            await srcBand.pixels.readAsync(distanceToSrcTopX, distanceToSrcTopY, length, width, data);
            const dstBand = await dstds.bands.getAsync(i + 1);
            await dstBand.pixels.writeAsync(distanceToSelfTopX, distanceToSelfTopY, length, width, data);
            await dstBand.flushAsync();
          }
          dstds.srs = srcSrs;
          dstds.geoTransform = [ extentDstds[0], resolution, 0, extentDstds[1], 0, -resolution ];
          await dstds.flushAsync();
        } catch (error) {
          dstds.close();
          throw error;
        }

        if (dstPng) {
          try {
            const dstdsPNG = await pngDriver.createCopyAsync(dstPng, dstds);
            dstdsPNG.close();
          } catch (error) {
            dstds.close();
            throw error;
          }
        }

      } else {
        // outside
      }

      return {
        minX: extentDstds[0],
        minY: extentDstds[3],
        maxX: extentDstds[2],
        maxY: extentDstds[1],
        length,
        width,
        resolution,
      };
    }
    finally {
      srcds.close();
    }
  }

  /**
    * 计算待裁剪区域
    * @param {Object} params 裁剪选项
    * @param {Array} params.srcExtent 原始影像4至
    * @param {Number} params.srcResolution 分辨率
    * @param {Array} params.dstExtent 目标影像4至
    * @param {Number} params.dstLength 目标影像长度
    * @param {Number} params.dstWidth 目标影像宽
    * @return {Promise<pix|null>} 待裁剪区域信息
    */
  async _cululate(params) {
    const { srcExtent, dstExtent, srcResolution, dstLength, dstWidth } = params;

    const [ srcXmin, srcYmax, srcXmax, srcYmin ] = srcExtent;
    const [ dstXmin, dstYmax, dstXmax, dstYmin ] = dstExtent;
    const srcPolygonWkt = `polygon ((${srcXmin} ${srcYmax}, ${srcXmin} ${srcYmin}, ${srcXmax} ${srcYmin},${srcXmax} ${srcYmax}, ${srcXmin} ${srcYmax}))`;
    const dstPolygonWkt = `polygon ((${dstXmin} ${dstYmax}, ${dstXmin} ${dstYmin}, ${dstXmax} ${dstYmin},${dstXmax} ${dstYmax}, ${dstXmin} ${dstYmax}))`;
    const srcGeometry = gdal.Geometry.fromWKT(srcPolygonWkt);
    const dstGeometry = gdal.Geometry.fromWKT(dstPolygonWkt);

    const intersect = await srcGeometry.intersectsAsync(dstGeometry);
    const contains = await srcGeometry.containsAsync(dstGeometry);

    const pix = {
      distanceToSrcTopX: 0,
      distanceToSrcTopY: 0,
      distanceToSelfTopX: 0,
      distanceToSelfTopY: 0,
      length: 0,
      width: 0,
    };

    if (contains) {
      pix.distanceToSrcTopX = Math.round((dstExtent[0] - srcExtent[0]) / srcResolution); // 目标影像左上角距离源影像左上角的X距离（像素）
      pix.distanceToSrcTopY = Math.round((srcExtent[1] - dstExtent[1]) / srcResolution); // 目标影像左上角距离源影像左上角的Y距离（像素）
      pix.distanceToSelfTopX = 0; // 目标影像距离自己左上角的X距离（像素）
      pix.distanceToSelfTopY = 0; // 目标影像距离自己左上角的Y距离（像素）
      pix.length = dstLength;
      pix.width = dstWidth;
    } else if (intersect) {
      const intersection = await srcGeometry.intersectionAsync(dstGeometry);
      const intersectionEnvelope = await intersection.getEnvelopeAsync();
      const intersectXin = intersectionEnvelope.minX;
      const intersectXmax = intersectionEnvelope.maxX;
      const intersectYin = intersectionEnvelope.minY;
      const intersectYmax = intersectionEnvelope.maxY;
      pix.distanceToSrcTopX = Math.round((intersectXin - srcExtent[0]) / srcResolution);// 目标影像左上角距离源影像左上角的X距离（像素）
      pix.distanceToSrcTopY = Math.round((srcExtent[1] - intersectYmax) / srcResolution);// 目标影像左上角距离源影像左上角的Y距离（像素）
      pix.distanceToSelfTopX = Math.round((intersectXin - dstExtent[0]) / srcResolution);// 目标影像与源影像相交的区域距离目标影像自己左上角的X距离（像素）
      pix.distanceToSelfTopY = Math.round((dstExtent[1] - intersectYmax) / srcResolution);// 目标影像与源影像相交的区域距离目标影像自己左上角的Y距离（像素）
      pix.length = Math.round((intersectXmax - intersectXin) / srcResolution);// 目标影像与源影像相交的像素
      pix.width = Math.round((intersectYmax - intersectYin) / srcResolution);// 目标影像与源影像相交的像素
    } else {
      return null;
    }

    return pix;
  }

  _checkGeojson(geojson) {
    if (typeof geojson !== 'object') {
      throw new Error('geojson error');
    }
    const { type, coordinates } = geojson;

    if (!type) {
      throw new Error('geojson type error');
    }
    if (!coordinates || !Array.isArray(coordinates)) {
      throw new Error('geojson coordinates error');
    }
    const geotype = [ 'POLYGON', 'MULTIPOLYGON' ];
    if (!geotype.includes(type.toUpperCase())) {
      throw new Error('only support Polygon or MultiPolygon');
    }
  }
}

module.exports = new Gdal();

