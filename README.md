# gdal-clip
clip tif using gdal

## Install

```sh
$ npm i @nononoyeah/gdal-clip
```  

## Usage  

```js
const gdalClip = require('@nononoyeah/gdal-clip');

const src = 'xxx.tif';
const dst = {
  tif: 'xxx_cliped.tif',
  png: 'xxx_cliped.png'
};
const options = {
  geojson: {
    'type':'Polygon',
    'bbox':[],
    'coordinates':[]
  },
};
gdalClip.clip(src, dst, options)
.then(data => {
  console.log(data);
})
.catch(error => {
  throw error;
});

```  
