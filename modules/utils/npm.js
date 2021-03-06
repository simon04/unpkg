import url from 'url';
import https from 'https';
import LRUCache from 'lru-cache';
import semver from 'semver';

import debug from './debug.js';
import bufferStream from './bufferStream.js';

const npmRegistryURL =
  process.env.NPM_REGISTRY_URL || 'https://registry.npmjs.org';

const agent = new https.Agent({
  keepAlive: true
});

const oneMegabyte = 1024 * 1024;
const oneSecond = 1000;
const oneMinute = oneSecond * 60;

const cache = new LRUCache({
  max: oneMegabyte * 40,
  length: Buffer.byteLength,
  maxAge: oneSecond
});

const notFound = '';

function get(options) {
  return new Promise((accept, reject) => {
    https.get(options, accept).on('error', reject);
  });
}

function isScopedPackageName(packageName) {
  return packageName.startsWith('@');
}

function encodePackageName(packageName) {
  return isScopedPackageName(packageName)
    ? `@${encodeURIComponent(packageName.substring(1))}`
    : encodeURIComponent(packageName);
}

async function fetchPackageInfo(packageName) {
  const name = encodePackageName(packageName);
  const infoURL = `${npmRegistryURL}/${name}`;

  debug('Fetching package info for %s from %s', packageName, infoURL);

  const { hostname, pathname } = url.parse(infoURL);
  const options = {
    agent: agent,
    hostname: hostname,
    path: pathname,
    headers: {
      Accept: 'application/json'
    }
  };

  const res = await get(options);

  if (res.statusCode === 200) {
    return bufferStream(res).then(JSON.parse);
  }

  if (res.statusCode === 404) {
    return null;
  }

  const data = await bufferStream(res);
  const content = data.toString('utf-8');

  throw new Error(
    `Failed to fetch info for ${packageName}\nstatus: ${res.statusCode}\ndata: ${content}`
  );
}

async function fetchVersionsAndTags(packageName) {
  const info = await fetchPackageInfo(packageName);

  if (!info) {
    return null;
  }

  return {
    versions: Object.keys(info.versions),
    tags: info['dist-tags']
  };
}

async function getVersionsAndTags(packageName) {
  const cacheKey = `versions-${packageName}`;
  const cacheValue = cache.get(cacheKey);

  if (cacheValue != null) {
    return cacheValue === notFound ? null : JSON.parse(cacheValue);
  }

  const value = await fetchVersionsAndTags(packageName);

  if (value == null) {
    cache.set(cacheKey, notFound, 5 * oneMinute);
    return null;
  }

  cache.set(cacheKey, JSON.stringify(value), oneMinute);
  return value;
}

function byVersion(a, b) {
  return semver.lt(a, b) ? -1 : semver.gt(a, b) ? 1 : 0;
}

/**
 * Returns an array of available versions, sorted by semver.
 */
export async function getAvailableVersions(packageName) {
  const versionsAndTags = await getVersionsAndTags(packageName);

  if (versionsAndTags) {
    return versionsAndTags.versions.sort(byVersion);
  }

  return [];
}

/**
 * Resolves the semver range or tag to a valid version.
 * Output is cached to avoid over-fetching from the registry.
 */
export async function resolveVersion(packageName, range) {
  const versionsAndTags = await getVersionsAndTags(packageName);

  if (versionsAndTags) {
    const { versions, tags } = versionsAndTags;

    if (range in tags) {
      range = tags[range];
    }

    return versions.includes(range)
      ? range
      : semver.maxSatisfying(versions, range);
  }

  return null;
}

// All the keys that sometimes appear in package info
// docs that we don't need. There are probably more.
const packageConfigExcludeKeys = [
  'browserify',
  'bugs',
  'directories',
  'engines',
  'files',
  'homepage',
  'keywords',
  'maintainers',
  'scripts'
];

function cleanPackageConfig(doc) {
  return Object.keys(doc).reduce((memo, key) => {
    if (!key.startsWith('_') && !packageConfigExcludeKeys.includes(key)) {
      memo[key] = doc[key];
    }

    return memo;
  }, {});
}

async function fetchPackageConfig(packageName, version) {
  const info = await fetchPackageInfo(packageName);

  if (!info || !(version in info.versions)) {
    return null;
  }

  return cleanPackageConfig(info.versions[version]);
}

/**
 * Returns metadata about a package, mostly the same as package.json.
 * Output is cached to avoid over-fetching from the registry.
 */
export async function getPackageConfig(packageName, version) {
  const cacheKey = `config-${packageName}-${version}`;
  const cacheValue = cache.get(cacheKey);

  if (cacheValue != null) {
    return cacheValue === notFound ? null : JSON.parse(cacheValue);
  }

  const value = await fetchPackageConfig(packageName, version);

  if (value == null) {
    cache.set(cacheKey, notFound, 5 * oneMinute);
    return null;
  }

  cache.set(cacheKey, JSON.stringify(value), oneMinute);
  return value;
}

/**
 * Returns a stream of the tarball'd contents of the given package.
 */
export async function getPackage(packageName, version) {
  const tarballName = isScopedPackageName(packageName)
    ? packageName.split('/')[1]
    : packageName;
  const tarballURL = `${npmRegistryURL}/${packageName}/-/${tarballName}-${version}.tgz`;

  debug('Fetching package for %s from %s', packageName, tarballURL);

  const { hostname, pathname } = url.parse(tarballURL);
  const options = {
    agent: agent,
    hostname: hostname,
    path: pathname
  };

  const res = await get(options);

  if (res.statusCode === 200) {
    return res;
  }

  const data = await bufferStream(res);
  const spec = `${packageName}@${version}`;
  const content = data.toString('utf-8');

  throw new Error(
    `Failed to fetch tarball for ${spec}\nstatus: ${res.statusCode}\ndata: ${content}`
  );
}
