#!/usr/bin/env node

/*
 * VAEM - Asset manager
 * Copyright (C) 2018  Wouter van de Molengraft
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

import {authorizationHeaders} from '../app/backend/util/source';

const _ = require('lodash');
const mongoose = require('mongoose');
const childProcess = require('child_process');
const util = require('util');

const config = require('../config/config');
const {Asset} = require('../app/backend/model/asset');
const s3 = require('../app/backend/util/s3');

const execFile = util.promisify(childProcess.execFile);
const getDuration = async source => {
  const {stdout} = await execFile('ffprobe', [
    '-print_format', 'json',
    '-show_format',
    '-headers', authorizationHeaders,
    source
  ]);

  const json = JSON.parse(stdout.toString());

  return parseFloat(_.get(json, 'format.duration'));
};

(async () => {
  await mongoose.connect(config.mongo);

  const assetId = process.argv[2];
  const asset = await Asset.findById(assetId);

  if (!asset) {
    throw 'Item not found';
  }

  if (asset.bitrates.length !== asset.jobs.length) {
    console.error(`Not all jobs are completed: ${_.difference(_.map(asset.jobs, 'maxrate'), asset.bitrates).join(', ')} are missing`);
    process.exit(1);
  }

  console.info('Verifying file count');
  // verify file counts on s3
  const objects = (await s3.listAllObjects({
    Prefix: `${assetId}/`,
    Bucket: config.s3.bucket
  })).filter(object => /\.ts$/.exec(object.Key));

  const counts = _.countBy(objects, object => object.Key.split('.')[1]);

  const max = _.max(_.values(counts));

  const faulty = _.keys(_.omit(counts, 'm3u8')).filter(bitrate => Math.abs(counts[bitrate] - max) >= 5);
  if (faulty.length > 0) {
    console.error(`File count for bitrates ${faulty.join(', ')} differ from maximum.`);
  }
  asset.bitrates = _.difference(asset.bitrates, faulty);

  // const good = [];
  // // verify durations of all bitrates
  // for(let bitrate of asset.bitrates)
  // {
  // 	if (bitrate === '1k')
  // 	{
  // 		good.push(bitrate);
  // 		return;
  // 	}
  //
  // 	console.info(`Checking duration for ${bitrate}`);
  // 	const duration = await getDuration(`http://localhost:${config.port}/player/streams/${assetId}/${assetId}.${bitrate}.m3u8`);
  // 	if (Math.abs(asset.videoParameters.duration - Math.floor(duration)) > 2)
  // 	{
  // 		console.error(`Duration for bitrate ${bitrate} (${duration}) differs from source (${asset.videoParameters.duration}).`);
  // 	}
  // 	else
  // 	{
  // 		good.push(bitrate);
  // 	}
  // }
  // asset.bitrates = good;

  await asset.save();

  if (asset.bitrates.length === asset.jobs.length) {
    console.info('Asset has been verified successfully');
  }

  await mongoose.disconnect();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
