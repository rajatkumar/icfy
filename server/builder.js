const { writeFileSync } = require('fs');
const { spawn, exec } = require('child_process');
const { join } = require('path');
const co = require('co');
const { readStatsFromFile, getViewerData } = require('webpack-bundle-analyzer/lib/analyzer');

const { getQueuedPushes, markPushAsProcessed, insertChunkStats } = require('./db');

const statsDir = join(process.cwd(), 'stats');
const repoDir = join(process.cwd(), 'wp-calypso');

function log(...args) {
	console.log(...args);
}

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}

function prcLog(data) {
	// console.log(`${data}`);
}

function cmd(cmdline, env = {}) {
	return new Promise((resolve, reject) => {
		log(`Executing: ${cmdline} in ${process.cwd()}`);
		const [command, ...args] = cmdline.split(' ');
		env = Object.assign({}, process.env, env);
		const proc = spawn(command, args, { shell: true, env });
		proc.stdout.on('data', prcLog);
		proc.stderr.on('data', prcLog);
		proc.on('close', code => {
			if (code === 0) {
				resolve(code);
			} else {
				reject(`${cmdline} exited with code ${code}`);
			}
		});
		proc.on('error', err => reject(`${cmdline} failed to execute: ${err}`));
	});
}

function exe(cmdline, env = {}) {
	return new Promise((resolve, reject) => {
		log(`Executing: ${cmdline} in ${process.cwd()}`);
		env = Object.assign({}, process.env, env);
		const proc = exec(cmdline, { env });
		proc.stdout.on('data', prcLog);
		proc.stderr.on('data', prcLog);
		proc.on('close', code => {
			if (code === 0) {
				resolve(code);
			} else {
				reject(`${cmdline} exited with code ${code}`);
			}
		});
		proc.on('error', err => reject(`${cmdline} failed to execute: ${err}`));
	});
}

const processPush = co.wrap(function*(push) {
	process.chdir(repoDir);

	// fetch the latest revisions from GitHub
	yield cmd('git fetch');

	// checkout the revision we want
	yield cmd(`git checkout ${push.sha}`);

	// run the build
	yield exe('npm run -s env -- node --max_old_space_size=8192 ./node_modules/.bin/webpack --config webpack.config.js --profile --json > stats.json', {
		NODE_ENV: 'production',
		WEBPACK_OUTPUT_JSON: 1
	});

	// generate the chart data
	log('Analyzing the bundle stats');
	yield analyzeBundle(push);

	// save the stat files
	// yield cmd(`mv stats.json ${statsDir}/${push.sha}-stats.json`);
	// yield cmd(`mv chart.json ${statsDir}/${push.sha}-chart.json`);

	// remove the stat files
	yield cmd('rm stats.json chart.json');

	// cleanup after the build
	yield cmd('npm run clean');

	process.chdir('..');
});

const analyzeBundle = co.wrap(function*(push) {
	const stats = readStatsFromFile('stats.json');
	const chart = getViewerData(stats, './public');
	writeFileSync('chart.json', JSON.stringify(chart, null, 2));

	for (const asset of chart) {
		const { sha, created_at } = push;
		const [ chunk, hash ] = asset.label.split('.');

		const newStat = {
			sha,
			created_at,
			chunk,
			hash,
			stat_size: asset.statSize,
			parsed_size: asset.parsedSize,
			gzip_size: asset.gzipSize
		};
		yield insertChunkStats(newStat);
		log(`Recorded new stat: sha=${sha} chunk=${chunk}`);
	}
});

const processQueue = co.wrap(function*() {
	while (true) {
		const pushes = yield getQueuedPushes();
		for (const push of pushes) {
			yield processPush(push);
			yield markPushAsProcessed(push.sha);
		}

		if (pushes.length === 0) {
			// wait a minute before querying for pushes again
			yield sleep(60000);
		}
	}
});

processQueue().catch(console.error);
