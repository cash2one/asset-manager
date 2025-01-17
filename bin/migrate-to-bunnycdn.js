#!/usr/bin/env node
/*
 * VAEM - Asset manager
 * Copyright (C) 2019  Wouter van de Molengraft
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import 'dotenv/config';
import _ from 'lodash';

import config from '~config';
import axios from 'axios';

import mongoose from 'mongoose';
import {bunnycdnStorage} from '../app/backend/util/bunnycdn';
import {listAllObjects} from '../app/backend/util/s3';
import cloudfrontSign from 'aws-cloudfront-sign';
import moment from 'moment';
import querystring from "querystring";
import {Bar} from 'cli-progress';
import {Asset} from '../app/backend/model/asset';

async function copyAsset(assetId) {
  const asset = await Asset.findById(assetId);
  if (asset.labels.indexOf('migrated') !== -1) {
    return;
  }

  const objects = await listAllObjects({
    Bucket: config.s3.bucket,
    Prefix: `${assetId}/`
  });

  const signedCookies = _.mapKeys(cloudfrontSign.getSignedCookies(
    `${config.cloudfront.base}/${assetId}/*`,
    _.extend({},
      config.cloudfront,
      {
        expireTime: moment().add(8, 'hours')
      })),
    (value, key) => key.replace(/^CloudFront-/, '')
  );

  const existing = (await bunnycdnStorage.get(`${assetId}/`)).data.map(item => {
    return `${assetId}/${item.ObjectName}`;
  }).concat(
    (await bunnycdnStorage.get(`${assetId}/subtitles/`)).data.map(item => {
      return `${assetId}/subtitles/${item.ObjectName}`;
    })
  );

  const keys = _.difference(
    _.map(objects, 'Key'),
    existing
  );

  let count = 0;
  const bar = new Bar();

  bar.start(keys.length, 0);
  for(let batch of _.chunk(keys, 4)) {
    await Promise.all(batch.map(async key => {
      const cloudfrontUrl = `${config.cloudfront.base}/${key}?${querystring.stringify(signedCookies)}`;

      const response = await axios.get(cloudfrontUrl, {
        responseType: 'stream'
      });

      await bunnycdnStorage.put(key, response.data);
      bar.update(++count);
    }));
  }

  asset.labels = [...asset.labels, 'migrated'];
  await asset.save();

  bar.stop();
}

(async () => {
  await mongoose.connect(config.mongo, {
    useNewUrlParser: true
  });
  await copyAsset('5cffebb6d27c8f000e1a7f7c');
  await mongoose.disconnect();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
