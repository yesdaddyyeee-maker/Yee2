import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import gplay from 'google-play-scraper';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOWNLOADS_DIR = './downloads';
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const userSearchResults = {};
const userSearchMessages = {};

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0',
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function getHeaders(site = 'apkcombo') {
  const ua = getRandomUserAgent();
  const isFirefox = ua.includes('Firefox');
  const isMac = ua.includes('Macintosh');
  const isLinux = ua.includes('Linux');
  
  const baseHeaders = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    'DNT': '1',
  };
  
  if (!isFirefox) {
    baseHeaders['sec-ch-ua'] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
    baseHeaders['sec-ch-ua-mobile'] = '?0';
    if (isMac) {
      baseHeaders['sec-ch-ua-platform'] = '"macOS"';
    } else if (isLinux) {
      baseHeaders['sec-ch-ua-platform'] = '"Linux"';
    } else {
      baseHeaders['sec-ch-ua-platform'] = '"Windows"';
    }
  }
  
  if (site === 'apkcombo') {
    baseHeaders['Referer'] = 'https://www.google.com/';
  } else if (site === 'uptodown') {
    baseHeaders['Referer'] = 'https://www.google.com/';
  } else if (site === 'apkpure') {
    baseHeaders['Referer'] = 'https://www.google.com/';
  }
  
  return baseHeaders;
}

// Retry function with exponential backoff and proxy support
async function axiosRetry(url, config = {}, maxRetries = 3) {
  let lastError = null;
  const site = config.site || 'apkcombo';
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const axiosConfig = {
        ...config,
        headers: { ...getHeaders(site), ...(config.headers || {}) },
        timeout: config.timeout || 20000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
      };
      
      delete axiosConfig.site;
      
      // On GitHub Actions, use proxy if available
      if (process.env.GITHUB_ACTIONS) {
        const proxyUrl = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY;
        if (proxyUrl) {
          axiosConfig.httpAgent = new HttpProxyAgent(proxyUrl);
          axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
        }
      }
      
      const response = await axios.get(url, axiosConfig);
      
      if (response.status === 403 || response.status === 429) {
        throw new Error(`Request blocked with status ${response.status}`);
      }
      
      return response;
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`⏳ إعادة محاولة (${attempt + 1}/${maxRetries}) بعد ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

const emojiToNumber = {
  '1️⃣': 1, '2️⃣': 2, '3️⃣': 3, '4️⃣': 4, '5️⃣': 5,
  '6️⃣': 6, '7️⃣': 7, '8️⃣': 8, '9️⃣': 9, '🔟': 10,
  '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5,
  '٦': 6, '٧': 7, '٨': 8, '٩': 9, '١٠': 10
};

function parseNumber(text) {
  const trimmed = text.trim();
  if (emojiToNumber[trimmed]) {
    return emojiToNumber[trimmed];
  }
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    return parseInt(numMatch[1]);
  }
  return null;
}

function getFileExtension(url, contentType) {
  if (url.includes('.xapk') || url.includes('xapk-package') || contentType?.includes('xapk')) return 'xapk';
  if (url.includes('.apks') || contentType?.includes('apks')) return 'apks';
  if (url.includes('.apkm') || contentType?.includes('apkm')) return 'apkm';
  if (url.includes('.obb')) return 'obb';
  return 'apk';
}

function getMimeType(extension) {
  const mimes = {
    'apk': 'application/vnd.android.package-archive',
    'xapk': 'application/vnd.android.package-archive',
    'apks': 'application/vnd.android.package-archive',
    'apkm': 'application/vnd.android.package-archive',
    'obb': 'application/octet-stream'
  };
  return mimes[extension] || 'application/octet-stream';
}

async function searchApps(query) {
  if (process.env.GITHUB_ACTIONS || process.env.CODESPACE_NAME) {
    console.log('🔍 بيئة GitHub/Codespace - استخدام Google Play للبحث...');
    return await searchAppsGPlay(query);
  }
  
  try {
    const searchUrl = `https://apkcombo.com/search/${encodeURIComponent(query)}`;
    console.log(`جاري البحث في APKCombo: ${query}`);
    
    const response = await axiosRetry(searchUrl, { timeout: 15000, site: 'apkcombo' });
    const $ = cheerio.load(response.data);
    
    const results = [];
    
    $('a').each((i, el) => {
      if (results.length >= 10) return false;
      
      const href = $(el).attr('href') || '';
      const title = $(el).attr('title') || $(el).text().trim();
      
      if (href.match(/^\/[^\/]+\/[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*\/?$/i)) {
        const parts = href.split('/').filter(p => p);
        if (parts.length >= 2) {
          const appId = parts[1];
          const name = title.replace(' APK', '').trim() || parts[0].replace(/-/g, ' ');
          
          if (!results.find(r => r.appId === appId) && name) {
            results.push({
              name: name.substring(0, 80),
              appId: appId,
              icon: '',
              developer: '',
              score: 0,
              url: `https://apkcombo.com${href}`
            });
          }
        }
      }
    });

    if (results.length === 0) {
      console.log('لم يتم العثور على نتائج في APKCombo، جاري البحث في Play Store...');
      return await searchAppsGPlay(query);
    }

    console.log(`تم العثور على ${results.length} نتيجة من APKCombo`);
    return results;
  } catch (error) {
    console.log('خطأ في البحث APKCombo:', error.message);
    return await searchAppsGPlay(query);
  }
}

async function searchAppsGPlay(query) {
  try {
    const results = await gplay.search({
      term: query,
      num: 10,
      lang: 'ar',
      country: 'eg'
    });

    return results.map(app => ({
      name: app.title.substring(0, 80),
      appId: app.appId,
      icon: app.icon,
      developer: app.developer,
      score: app.score,
      url: app.url
    }));
  } catch (error) {
    try {
      const results = await gplay.search({
        term: query,
        num: 10,
        lang: 'en',
        country: 'us'
      });

      return results.map(app => ({
        name: app.title.substring(0, 80),
        appId: app.appId,
        icon: app.icon,
        developer: app.developer,
        score: app.score,
        url: app.url
      }));
    } catch (err) {
      throw new Error(`فشل البحث: ${err.message}`);
    }
  }
}

async function getAppDetails(appId) {
  try {
    const app = await gplay.app({ appId, lang: 'ar', country: 'eg' });

    return {
      name: app.title,
      appId: app.appId,
      version: app.version || 'غير معروف',
      size: app.size || 'غير معروف',
      developer: app.developer,
      icon: app.icon,
      description: app.summary || '',
      installs: app.installs || '',
      score: app.score || 0
    };
  } catch (error) {
    try {
      const app = await gplay.app({ appId, lang: 'en', country: 'us' });

      return {
        name: app.title,
        appId: app.appId,
        version: app.version || 'Unknown',
        size: app.size || 'Unknown',
        developer: app.developer,
        icon: app.icon,
        description: app.summary || '',
        installs: app.installs || '',
        score: app.score || 0
      };
    } catch (err) {
      throw new Error(`فشل جلب معلومات التطبيق: ${err.message}`);
    }
  }
}

async function findApkComboSlug(appId, appName) {
  try {
    const searchUrl = `https://apkcombo.com/search/${encodeURIComponent(appName)}`;
    const response = await axiosRetry(searchUrl, { timeout: 15000 });
    const $ = cheerio.load(response.data);

    let slug = null;

    $('a[title$=" APK"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.includes(appId)) {
        const match = href.match(/\/([^\/]+)\/([^\/]+)\/?$/);
        if (match && match[2] === appId) {
          slug = match[1];
          return false;
        }
      }
    });

    if (!slug) {
      const slugFromName = appName.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
      slug = slugFromName;
    }

    return slug;
  } catch (error) {
    const slugFromName = appName.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    return slugFromName;
  }
}

function generateDownloadLinks(appId, appName) {
  const encodedName = encodeURIComponent(appName);
  const slug = appName.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  
  return {
    playStore: `https://play.google.com/store/apps/details?id=${appId}`,
    apkCombo: `https://apkcombo.com/${slug}/${appId}/download/apk`,
    uptodown: `https://en.uptodown.com/android/search/${encodedName}`,
    apkPure: `https://apkpure.com/search?q=${encodedName}`,
    apkMirror: `https://www.apkmirror.com/?s=${encodedName}`
  };
}

async function getDownloadInfo(appId, appName) {
  try {
    console.log(`جاري جلب رابط التحميل لـ: ${appName}`);

    const slug = appName.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();

    const pageUrl = `https://apkcombo.com/${slug}/${appId}/download/apk`;
    console.log(`جاري فتح صفحة: ${pageUrl}`);
    
    const pageResponse = await axiosRetry(pageUrl, { timeout: 20000 });
    const $ = cheerio.load(pageResponse.data);

    let downloadUrl = null;
    let fileType = 'apk';

    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('/r2?u=') && !downloadUrl) {
        const encodedUrl = href.split('/r2?u=')[1];
        if (encodedUrl) {
          downloadUrl = decodeURIComponent(encodedUrl);
          
          if (downloadUrl.includes('.xapk') || downloadUrl.includes('xapk-package')) {
            fileType = 'xapk';
          } else if (downloadUrl.includes('.apks')) {
            fileType = 'apks';
          }
          
          console.log(`تم العثور على رابط R2 CDN (${fileType})`);
          return false;
        }
      }
    });

    if (!downloadUrl) {
      const r2Match = pageResponse.data.match(/\/r2\?u=([^"'\s]+)/);
      if (r2Match) {
        downloadUrl = decodeURIComponent(r2Match[1]);
        if (downloadUrl.includes('.xapk')) fileType = 'xapk';
        else if (downloadUrl.includes('.apks')) fileType = 'apks';
        console.log(`تم العثور على رابط R2 CDN من regex (${fileType})`);
      }
    }

    if (downloadUrl) {
      return { url: downloadUrl, fileType };
    }

    console.log('لم يتم العثور على رابط R2، جاري تجربة الطريقة البديلة...');
    return await getDownloadInfoAlt(appId, slug);

  } catch (error) {
    console.log('خطأ في جلب رابط التحميل:', error.message);
    return null;
  }
}

async function getDownloadInfoAlt(appId, slug) {
  try {
    const altUrls = [
      `https://apkcombo.com/${slug}/${appId}/download/phone-apk`,
      `https://apkcombo.com/${slug}/${appId}/download/phone-latest-apk`,
    ];

    for (const pageUrl of altUrls) {
      try {
        console.log(`جاري تجربة: ${pageUrl}`);
        const pageResponse = await axiosRetry(pageUrl, { timeout: 20000 });
        const $ = cheerio.load(pageResponse.data);

        let downloadUrl = null;
        let fileType = 'apk';

        $('a[href*="/r2?u="]').each((i, el) => {
          const href = $(el).attr('href') || '';
          const encodedUrl = href.split('/r2?u=')[1];
          if (encodedUrl && !downloadUrl) {
            downloadUrl = decodeURIComponent(encodedUrl);
            if (downloadUrl.includes('.xapk')) fileType = 'xapk';
            else if (downloadUrl.includes('.apks')) fileType = 'apks';
            return false;
          }
        });

        if (!downloadUrl) {
          const r2Match = pageResponse.data.match(/\/r2\?u=([^"'\s&]+)/);
          if (r2Match) {
            downloadUrl = decodeURIComponent(r2Match[1]);
            if (downloadUrl.includes('.xapk')) fileType = 'xapk';
            else if (downloadUrl.includes('.apks')) fileType = 'apks';
          }
        }

        if (downloadUrl) {
          console.log(`تم العثور على رابط CDN (${fileType})`);
          return { url: downloadUrl, fileType };
        }
      } catch (e) {
        continue;
      }
    }

    console.log('لم يتم العثور على R2، جاري تجربة طريقة API القديمة...');
    return await getDownloadInfoLegacy(appId, slug);
  } catch (error) {
    console.log('خطأ في الطريقة البديلة:', error.message);
    return null;
  }
}

async function getDownloadInfoLegacy(appId, slug) {
  try {
    const pageUrl = `https://apkcombo.com/${slug}/${appId}/download/phone-latest-apk`;
    console.log(`[Legacy] جاري فتح: ${pageUrl}`);
    
    const pageResponse = await axiosRetry(pageUrl, { timeout: 20000 });
    
    const xidMatch = pageResponse.data.match(/xid\s*=\s*["']([^"']+)["']/);
    if (!xidMatch) {
      console.log('[Legacy] لم يتم العثور على xid');
      return null;
    }
    const xid = xidMatch[1];
    console.log(`[Legacy] XID: ${xid}`);

    let token = '';
    try {
      const tokenResponse = await axiosRetry('https://apkcombo.com/checkin', { 
        timeout: 10000 
      });
      token = tokenResponse.data;
      console.log('[Legacy] تم الحصول على التوكن');
    } catch (e) {
      console.log('[Legacy] فشل جلب التوكن، متابعة بدونه');
    }

    const dlUrl = `https://apkcombo.com/${slug}/${appId}/${xid}/dl`;
    console.log(`[Legacy] جاري طلب: ${dlUrl}`);
    
    const formData = new URLSearchParams();
    formData.append('package_name', appId);
    formData.append('version', '');

    const dlResponse = await axios.post(dlUrl, formData, {
      headers: { ...getHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000
    });

    let downloadMatch = dlResponse.data.match(/href=["'](https:\/\/apkcombo\.com\/d\?u=[^"']+)["']/);
    if (!downloadMatch) {
      downloadMatch = dlResponse.data.match(/href=["']([^"']*\/d\?u=[^"']+)["']/);
    }
    
    if (!downloadMatch) {
      const r2Match = dlResponse.data.match(/\/r2\?u=([^"'\s&]+)/);
      if (r2Match) {
        const downloadUrl = decodeURIComponent(r2Match[1]);
        let fileType = 'apk';
        if (downloadUrl.includes('.xapk')) fileType = 'xapk';
        else if (downloadUrl.includes('.apks')) fileType = 'apks';
        console.log(`[Legacy] تم العثور على R2 من dl (${fileType})`);
        return { url: downloadUrl, fileType };
      }
      console.log('[Legacy] لم يتم العثور على رابط التحميل');
      return null;
    }

    let downloadLink = downloadMatch[1];
    if (!downloadLink.startsWith('http')) {
      downloadLink = 'https://apkcombo.com' + downloadLink;
    }
    console.log('[Legacy] تم العثور على رابط التحميل');

    const finalUrl = token ? downloadLink + '&' + token : downloadLink;
    
    try {
      const finalResponse = await axios.get(finalUrl, {
        headers: getHeaders(),
        maxRedirects: 0,
        validateStatus: (status) => status === 302 || status === 301 || status === 200
      });

      const redirectUrl = finalResponse.headers.location;
      if (redirectUrl) {
        console.log('[Legacy] تم الحصول على رابط CDN');
        let fileType = 'apk';
        if (redirectUrl.includes('/XAPK/') || redirectUrl.includes('.xapk')) {
          fileType = 'xapk';
        } else if (redirectUrl.includes('/APKS/') || redirectUrl.includes('.apks')) {
          fileType = 'apks';
        }
        return { url: redirectUrl, fileType };
      }
      
      if (finalResponse.data) {
        const cdnMatch = finalResponse.data.match(/https:\/\/[^"'\s]+\.(?:apk|xapk|apks)/i);
        if (cdnMatch) {
          let fileType = 'apk';
          if (cdnMatch[0].includes('.xapk')) fileType = 'xapk';
          else if (cdnMatch[0].includes('.apks')) fileType = 'apks';
          console.log(`[Legacy] تم استخراج رابط CDN (${fileType})`);
          return { url: cdnMatch[0], fileType };
        }
      }
    } catch (e) {
      console.log('[Legacy] خطأ في التحويل:', e.message);
    }

    console.log('[Legacy] لم يتم العثور على الرابط النهائي');
    return null;

  } catch (error) {
    console.log('[Legacy] خطأ:', error.message);
    return null;
  }
}

async function getDownloadFromUptodown(appId, appName) {
  try {
    console.log('[Uptodown] جاري البحث عن التطبيق...');
    
    const slug = appName.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    
    const searchUrl = `https://en.uptodown.com/android/search/${encodeURIComponent(appName)}`;
    
    const response = await axiosRetry(searchUrl, { 
      timeout: 15000,
      site: 'uptodown'
    });
    
    const $ = cheerio.load(response.data);
    
    let appUrl = null;
    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('.uptodown.com/android') && !href.includes('/search/')) {
        if (!appUrl) {
          appUrl = href;
          return false;
        }
      }
    });
    
    if (!appUrl) {
      console.log('[Uptodown] لم يتم العثور على التطبيق');
      return null;
    }
    
    console.log(`[Uptodown] تم العثور على: ${appUrl}`);
    
    const downloadPageUrl = appUrl.endsWith('/') ? 
      appUrl + 'download' : appUrl + '/download';
    
    const downloadPage = await axiosRetry(downloadPageUrl, { 
      timeout: 15000,
      site: 'uptodown'
    });
    
    const $dl = cheerio.load(downloadPage.data);
    
    let downloadUrl = null;
    
    const dataUrl = $dl('[data-url]').attr('data-url');
    if (dataUrl) {
      downloadUrl = dataUrl;
    }
    
    if (!downloadUrl) {
      const downloadBtn = $dl('a[href*="/download/"], button[data-url]').first();
      downloadUrl = downloadBtn.attr('href') || downloadBtn.attr('data-url');
    }
    
    if (!downloadUrl) {
      const linkMatch = downloadPage.data.match(/https:\/\/[^"'\s]+\.apk/i);
      if (linkMatch) {
        downloadUrl = linkMatch[0];
      }
    }
    
    if (downloadUrl) {
      console.log('[Uptodown] تم العثور على رابط التحميل');
      return { url: downloadUrl, fileType: 'apk' };
    }
    
    console.log('[Uptodown] لم يتم العثور على رابط التحميل');
    return null;
    
  } catch (error) {
    console.log('[Uptodown] خطأ:', error.message);
    return null;
  }
}

async function getDownloadFromAPKPure(appId, appName) {
  try {
    console.log('[APKPure] جاري البحث عن التطبيق...');
    
    const searchUrl = `https://apkpure.com/search?q=${encodeURIComponent(appId)}`;
    
    const response = await axiosRetry(searchUrl, { 
      timeout: 15000,
      site: 'apkpure'
    });
    
    const $ = cheerio.load(response.data);
    
    let appUrl = null;
    $('a[href*="/download/"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes(appId) && !appUrl) {
        appUrl = href.startsWith('http') ? href : `https://apkpure.com${href}`;
        return false;
      }
    });
    
    if (!appUrl) {
      $('a').each((i, el) => {
        const href = $(el).attr('href') || '';
        if (href.includes(appId) && href.includes('/download') && !appUrl) {
          appUrl = href.startsWith('http') ? href : `https://apkpure.com${href}`;
          return false;
        }
      });
    }
    
    if (!appUrl) {
      console.log('[APKPure] لم يتم العثور على التطبيق');
      return null;
    }
    
    console.log(`[APKPure] تم العثور على: ${appUrl}`);
    
    const downloadPage = await axiosRetry(appUrl, { 
      timeout: 15000,
      site: 'apkpure'
    });
    
    const $dl = cheerio.load(downloadPage.data);
    
    let downloadUrl = null;
    let fileType = 'apk';
    
    $dl('a[href*=".apk"], a[href*="download.apkpure"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('.apk') || href.includes('download.apkpure')) {
        downloadUrl = href;
        if (href.includes('.xapk')) fileType = 'xapk';
        return false;
      }
    });
    
    if (!downloadUrl) {
      const linkMatch = downloadPage.data.match(/https:\/\/[^"'\s]+\.(?:apk|xapk)/i);
      if (linkMatch) {
        downloadUrl = linkMatch[0];
        if (downloadUrl.includes('.xapk')) fileType = 'xapk';
      }
    }
    
    if (downloadUrl) {
      console.log(`[APKPure] تم العثور على رابط التحميل (${fileType})`);
      return { url: downloadUrl, fileType };
    }
    
    console.log('[APKPure] لم يتم العثور على رابط التحميل');
    return null;
    
  } catch (error) {
    console.log('[APKPure] خطأ:', error.message);
    return null;
  }
}

async function getDownloadWithFallback(appId, appName) {
  console.log(`🔍 جاري البحث عن رابط تحميل: ${appName}`);
  
  let downloadInfo = await getDownloadInfo(appId, appName);
  if (downloadInfo) {
    console.log('✅ تم العثور على الرابط من APKCombo');
    return downloadInfo;
  }
  
  console.log('⚠️ APKCombo فشل، جاري تجربة Uptodown...');
  downloadInfo = await getDownloadFromUptodown(appId, appName);
  if (downloadInfo) {
    console.log('✅ تم العثور على الرابط من Uptodown');
    return downloadInfo;
  }
  
  console.log('⚠️ Uptodown فشل، جاري تجربة APKPure...');
  downloadInfo = await getDownloadFromAPKPure(appId, appName);
  if (downloadInfo) {
    console.log('✅ تم العثور على الرابط من APKPure');
    return downloadInfo;
  }
  
  console.log('❌ فشل جميع المصادر');
  return null;
}

async function downloadAndSend(sock, sender, url, appName, version, fileType = 'apk') {
  const cleanName = appName
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const actualFileType = getFileExtension(url, null) || fileType;
  const displayName = `${cleanName}_${version}.${actualFileType}`;

  console.log(`جاري إرسال: ${displayName}`);

  try {
    await sock.sendMessage(sender, {
      document: { url: url },
      fileName: displayName,
      mimetype: getMimeType(actualFileType)
    });

    console.log(`تم الإرسال: ${displayName}`);

    await sock.sendMessage(sender, {
      text: '📱 تابعني على انستجرام من فضلك\nhttps://www.instagram.com/omarxarafp'
    });

    return {
      success: true,
      fileName: displayName,
      fileType: actualFileType
    };
  } catch (sendErr) {
    throw new Error(`خطأ في الإرسال: ${sendErr.message}`);
  }
}

let retryCount = 0;
const MAX_RETRIES = 5;
let pairingCodeRequested = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => delay(1000 + Math.random() * 2000);

async function sendMessageSafely(sock, jid, content, options = {}) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await delay(500 + Math.random() * 1000);
    const result = await sock.sendMessage(jid, content, options);
    await sock.sendPresenceUpdate('unavailable', jid);
    return result;
  } catch (e) {
    return await sock.sendMessage(jid, content, options);
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`إصدار WhatsApp: ${version.join('.')} (أحدث: ${isLatest ? 'نعم' : 'لا'})`);

  const phoneNumber = process.env.PHONE_NUMBER || '';
  
  // التحقق من وجود بيانات اعتماد محفوظة
  const hasExistingCreds = state.creds && state.creds.me;

  if (!phoneNumber && !hasExistingCreds) {
    console.log('═══════════════════════════════════════');
    console.log('   يرجى تعيين رقم الهاتف في PHONE_NUMBER');
    console.log('   مثال: 201234567890');
    console.log('═══════════════════════════════════════');
    return;
  }
  
  if (hasExistingCreds) {
    console.log('✓ تم العثور على بيانات اعتماد محفوظة');
  }

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    emitOwnEvents: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting') {
      console.log('جاري الاتصال بـ WhatsApp...');
    }

    if (qr && !pairingCodeRequested && !sock.authState.creds.registered) {
      pairingCodeRequested = true;
      try {
        console.log('جاري طلب رمز الاقتران...');
        const code = await sock.requestPairingCode(phoneNumber);
        const displayCode = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('═══════════════════════════════════════');
        console.log('   رمز الاقتران: ' + displayCode);
        console.log('');
        console.log('   خطوات الربط:');
        console.log('   1. افتح WhatsApp');
        console.log('   2. الإعدادات > الأجهزة المرتبطة');
        console.log('   3. ربط جهاز > الربط برقم الهاتف');
        console.log('   4. أدخل الرمز أعلاه');
        console.log('═══════════════════════════════════════');
      } catch (error) {
        console.log('خطأ في طلب رمز الاقتران:', error.message);
        pairingCodeRequested = false;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('انقطع الاتصال - الكود:', statusCode || 'غير معروف');
      pairingCodeRequested = false;

      if (shouldReconnect && retryCount < MAX_RETRIES) {
        retryCount++;
        const delay = retryCount * 10000;
        console.log(`إعادة الاتصال (${retryCount}/${MAX_RETRIES}) بعد ${delay/1000} ثانية...`);
        setTimeout(() => connectToWhatsApp(), delay);
      } else if (retryCount >= MAX_RETRIES) {
        console.log('تم تجاوز الحد الأقصى للمحاولات.');
      } else {
        console.log('تم تسجيل الخروج. احذف مجلد auth_info وأعد التشغيل.');
      }
    } else if (connection === 'open') {
      retryCount = 0;
      pairingCodeRequested = false;
      console.log('═══════════════════════════════════════');
      console.log('   تم الاتصال بـ WhatsApp بنجاح!');
      console.log('   البوت جاهز للعمل (وضع غير متصل)');
      console.log('═══════════════════════════════════════');
      
      // Set presence to offline/unavailable
      await sock.sendPresenceUpdate('unavailable');
    }
  });

  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      const callerId = call.from;
      const phoneNum = callerId.split('@')[0];

      if (call.status === 'offer') {
        console.log(`═══════════════════════════════════════`);
        console.log(`   مكالمة واردة من: ${phoneNum}`);
        console.log(`   جاري حظر المستخدم...`);
        console.log(`═══════════════════════════════════════`);

        try {
          await sock.updateBlockStatus(callerId, 'block');
          console.log(`✓ تم حظر ${phoneNum} بنجاح`);
        } catch (error) {
          console.log(`✗ خطأ في حظر ${phoneNum}:`, error.message);
        }
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const sender = msg.key.remoteJid;
      const text = (msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || '').trim();

      if (!text) continue;

      console.log(`رسالة من ${sender}: ${text}`);

      const selectedNumber = parseNumber(text);

      if (selectedNumber && userSearchResults[sender]) {
        const selectedIndex = selectedNumber - 1;
        const apps = userSearchResults[sender];

        if (selectedIndex < 0 || selectedIndex >= apps.length) {
          await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } });
          continue;
        }

        await sock.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        if (userSearchMessages[sender]) {
          try {
            await sock.sendMessage(sender, { delete: userSearchMessages[sender] });
          } catch (e) {}
          delete userSearchMessages[sender];
        }

        const selectedApp = apps[selectedIndex];

        try {
          const details = await getAppDetails(selectedApp.appId);

          let infoText = `*${details.name}*\n\n`;
          infoText += `Package: \`${details.appId}\`\n`;
          infoText += `Version: ${details.version}\n`;
          infoText += `Size: ${details.size}\n`;
          infoText += `Developer: ${details.developer}\n`;
          infoText += `Rating: ${details.score ? details.score.toFixed(1) + '/5' : 'N/A'}\n`;
          infoText += `Downloads: ${details.installs}`;

          if (details.icon) {
            try {
              await sock.sendMessage(sender, {
                image: { url: details.icon },
                caption: infoText
              });
            } catch (imgErr) {
              await sock.sendMessage(sender, { text: infoText });
            }
          } else {
            await sock.sendMessage(sender, { text: infoText });
          }

          const links = generateDownloadLinks(selectedApp.appId, details.name);
          const downloadInfo = await getDownloadWithFallback(selectedApp.appId, selectedApp.name);

          if (!downloadInfo) {
            let fallbackText = `*لم يتم العثور على رابط تحميل مباشر*\n\n`;
            fallbackText += `يمكنك تحميل التطبيق من:\n\n`;
            fallbackText += `📱 Play Store:\n${links.playStore}\n\n`;
            fallbackText += `📦 Uptodown:\n${links.uptodown}\n\n`;
            fallbackText += `📦 APKPure:\n${links.apkPure}\n\n`;
            fallbackText += `📦 APKMirror:\n${links.apkMirror}`;
            
            await sock.sendMessage(sender, { text: fallbackText });
            delete userSearchResults[sender];
            continue;
          }

          try {
            await downloadAndSend(sock, sender, downloadInfo.url, details.name, details.version, downloadInfo.fileType);
            delete userSearchResults[sender];
          } catch (dlError) {
            console.log('خطأ في التحميل:', dlError.message);
            
            let fallbackText = `*فشل التحميل التلقائي*\n\n`;
            fallbackText += `يمكنك تحميل التطبيق يدوياً من:\n\n`;
            fallbackText += `📱 Play Store:\n${links.playStore}\n\n`;
            fallbackText += `📦 Uptodown:\n${links.uptodown}\n\n`;
            fallbackText += `📦 APKPure:\n${links.apkPure}`;
            
            await sock.sendMessage(sender, { text: fallbackText });
          }

        } catch (error) {
          console.log('خطأ في جلب المعلومات:', error.message);
          await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        }
      } else {
        const query = text;

        await sock.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

        try {
          const apps = await searchApps(query);

          if (apps.length === 0) {
            await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } });
            continue;
          }

          userSearchResults[sender] = apps;

          let resultText = '';
          apps.forEach((app, index) => {
            resultText += `${numberEmojis[index]} ${app.name}\n`;
          });
          resultText += '\n✏️ *اكتب الرقم لتحميل التطبيق*';

          const sentMsg = await sock.sendMessage(sender, {
            image: { url: 'https://i.postimg.cc/L9g2BjwB/profile.jpg' },
            caption: resultText.trim()
          });
          userSearchMessages[sender] = sentMsg.key;

          await sock.sendMessage(sender, { react: { text: '✅', key: msg.key } });

        } catch (error) {
          console.log('خطأ في البحث:', error.message);
          await sock.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        }
      }
    }
  });
}

console.log('═══════════════════════════════════════');
console.log('   OMARDEV WhatsApp Bot - APKCombo');
console.log('   يدعم: APK, XAPK, APKS, APKM, OBB');
console.log('═══════════════════════════════════════');

connectToWhatsApp();
