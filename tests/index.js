"use strict";

const chunker = require('..');
const assert = require('assert');
const fs = require('fs');
const co = require('co');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const stream = require('stream');

function streamToBuffer(stream) {
	return new Promise(function(resolve, reject) {
		let buf = new Buffer(0);
		stream.on('data', function(data) {
			buf = Buffer.concat([buf, data]);
		});
		stream.once('end', function() {
			resolve(buf);
		});
	});
}

/**
 * Like streamToBuffer, but use real files to create backpressure.
 */
function streamToFileToBuffer(stream) {
	const tempFname = path.join(os.tmpdir(), 'chopshop-tests-' + Math.random());
	const writeStream = fs.createWriteStream(tempFname);
	return new Promise(function(resolve) {
		writeStream.once('finish', function() {
			const buf = fs.readFileSync(tempFname);
			fs.unlinkSync(tempFname);
			resolve(buf);
		});
		stream.pipe(writeStream);
	});
}

describe('chunker', function() {
	it('throws Error for bad chunkSizes', function() {
		for(let chunkSize of [0.5, -0.5, -2, false, "3"]) {
			assert.throws(function() {
				const c = chunker.chunk(null, chunkSize);
				c.next();
			}, /chunkSize must be/);
		}
	});

	it('throws Error when asked to yield another chunk before the previous chunk is fully read', function() {
		const input = crypto.pseudoRandomBytes(1024);
		const tempfname = `${os.tmpdir()}/chunkertest`;
		const f = fs.openSync(tempfname, 'w');
		fs.writeSync(f, input, 0, input.length);
		fs.closeSync(f);

		const inputStream = fs.createReadStream(tempfname);

		const iter = chunker.chunk(inputStream, 128);
		iter.next();
		assert.throws(function() {
			iter.next();
		}, /until the previous chunk is fully read/);
	});

	const testChunking = co.wrap(function*(doPassThrough) {
		const params = [
			 {inputSize: 0, chunkSize: 1}
			,{inputSize: 1, chunkSize: 1}
			,{inputSize: 3, chunkSize: 2}
			,{inputSize: 3, chunkSize: 10}
			,{inputSize: 1024*1024, chunkSize: 100}
			,{inputSize: 1024*1024, chunkSize: 128*1024}
			,{inputSize: 1024*1024, chunkSize: 1024*1024*10}
			,{inputSize: 1024*1024, chunkSize: 17*1024}
			,{inputSize: 1024*1024*4.5, chunkSize: 1024*1024}
		];
		for(let p of params) {
			//console.log(p);
			const inputSize = p.inputSize;
			const chunkSize = p.chunkSize;
			const input = crypto.pseudoRandomBytes(inputSize);

			const tempfname = `${os.tmpdir()}/chunkertest`;
			const f = fs.openSync(tempfname, 'w');
			fs.writeSync(f, input, 0, input.length);
			fs.closeSync(f);

			let inputStream = fs.createReadStream(tempfname);
			// If doPassThrough, pipe data through a PassThrough stream,
			// which changes the read size (?) and backpressure.
			if(doPassThrough) {
				const passThrough = new stream.PassThrough();
				inputStream.pipe(passThrough);
				inputStream = passThrough;
			}

			let count = 0;
			for(let chunkStream of chunker.chunk(inputStream, chunkSize)) {
				//console.log({chunkStream});
				// Use streamToFileToBuffer instead of streamToBuffer to add some
				// backpressure.  Needed to catch the lack-of-'end'-event bug
				// present in chopshop 0.1.2.
				//let writeBuf = yield streamToBuffer(chunkStream);
				let writeBuf = yield streamToFileToBuffer(chunkStream);

				if(count == Math.floor(input.length / chunkSize)) {
					assert.deepEqual(input.slice(chunkSize * count), writeBuf);
				} else {
					assert.equal(writeBuf.length, chunkSize);
					assert.deepEqual(input.slice(chunkSize * count, chunkSize * count + chunkSize), writeBuf);
				}
				count += 1;
			}

			const expectedChunks = Math.max(1, Math.ceil(inputSize / chunkSize));
			assert.equal(count, expectedChunks);
		}
	});

	it('chunks a stream into smaller streams', function() {
		this.timeout(8000);
		return testChunking(false);
	});

	it('chunks a stream with extra buffering into smaller streams', function() {
		this.timeout(8000);
		return testChunking(true);
	});
});
