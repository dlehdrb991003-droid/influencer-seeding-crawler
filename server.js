const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json({ limit: '1mb' }));

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const CRAWLER_SECRET = process.env.CRAWLER_SECRET;

// ─── Health check (no auth) ───────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (CRAWLER_SECRET && req.headers['x-crawler-secret'] !== CRAWLER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Browser helpers ──────────────────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });
}

function extractEmail(text) {
  const m = text?.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

function extractInstagram(text) {
  const m = text?.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/);
  return m ? `https://www.instagram.com/${m[1]}` : null;
}

// ─── POST /youtube/about ──────────────────────────────────────────────────────
// YouTube About 페이지에서 인스타그램 링크 및 이메일 수집
// Body: { channels: { channelId: string, handle?: string }[] }
// Returns: { results: { channelId, email, instagramLink }[] }
app.post('/youtube/about', async (req, res) => {
  const { channels } = req.body;
  if (!Array.isArray(channels) || channels.length === 0) {
    return res.status(400).json({ error: 'channels array required' });
  }

  const browser = await launchBrowser();
  const results = [];

  async function scrapeChannel(channelId, handle) {
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );

      const url = handle
        ? `https://www.youtube.com/${handle}/about`
        : `https://www.youtube.com/channel/${channelId}/about`;

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      const redirectLinks = await page.$$eval(
        'a[href*="youtube.com/redirect"]',
        els => els.map(el => {
          try {
            const u = new URL(el.getAttribute('href'));
            return u.searchParams.get('q') || '';
          } catch { return ''; }
        }).filter(Boolean)
      );

      const descText = await page.evaluate(() => {
        const el = document.querySelector(
          'ytd-channel-about-metadata-renderer, #description-container, #bio'
        );
        return el ? el.textContent : '';
      });

      const email =
        redirectLinks.find(l => l.startsWith('mailto:'))?.slice(7) ??
        extractEmail(descText);
      const instagramLink =
        redirectLinks.find(l => l.includes('instagram.com/')) ??
        extractInstagram(descText);

      console.log(`[youtube/about] ${channelId}: email=${email}, ig=${instagramLink}`);
      return { channelId, email: email ?? null, instagramLink: instagramLink ?? null };
    } catch (err) {
      console.error(`[youtube/about] ${channelId} error:`, err.message);
      return { channelId, email: null, instagramLink: null };
    } finally {
      await page.close();
    }
  }

  try {
    // 5개씩 병렬 처리
    const BATCH = 5;
    for (let i = 0; i < channels.length; i += BATCH) {
      const batch = channels.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(({ channelId, handle }) => scrapeChannel(channelId, handle)));
      results.push(...batchResults);
    }
  } finally {
    await browser.close();
  }

  res.json({ results });
});

// ─── Instagram public API ─────────────────────────────────────────────────────
async function fetchIGProfileAPI(username) {
  try {
    const res = await fetch(
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A329 Instagram 302.0.0.36.111',
          'Accept': '*/*',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'X-IG-App-ID': '936619743392459',
          'Referer': 'https://www.instagram.com/',
        },
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.user ?? null;
  } catch {
    return null;
  }
}

function toIGProfile(userData) {
  const posts = (userData.edge_owner_to_timeline_media?.edges ?? [])
    .slice(0, 24)
    .map(({ node }) => ({
      url: `https://www.instagram.com/p/${node.shortcode}/`,
      shortCode: node.shortcode,
      type: node.__typename,
      isReel: node.__typename === 'GraphVideo',
      likes: node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? 0,
      comments: node.edge_media_to_comment?.count ?? 0,
      caption: node.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
      timestamp: new Date((node.taken_at_timestamp ?? 0) * 1000).toISOString(),
      commentsList: [],
    }));

  return {
    username: userData.username,
    fullName: userData.full_name ?? '',
    biography: userData.biography ?? '',
    followersCount: userData.edge_followed_by?.count ?? 0,
    followsCount: userData.edge_follow?.count ?? 0,
    profilePicUrl: userData.profile_pic_url_hd ?? userData.profile_pic_url ?? '',
    posts,
  };
}

// ─── POST /instagram/profile ──────────────────────────────────────────────────
// Instagram 프로필 + 최근 게시물 최대 24개 수집
// Body: { username: string }
// Returns: InstagramProfile
app.post('/instagram/profile', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  // 1차: 공개 API
  let userData = await fetchIGProfileAPI(username);
  console.log(`[instagram/profile] ${username}: public API ${userData ? 'OK' : 'blocked'}`);

  // 2차: Puppeteer + 응답 가로채기
  if (!userData) {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });

      page.on('response', async (response) => {
        if (userData) return;
        const url = response.url();
        if (!url.includes('web_profile_info') && !url.includes('graphql')) return;
        try {
          const json = await response.json();
          if (json?.data?.user) userData = json.data.user;
        } catch {}
      });

      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await new Promise(r => setTimeout(r, 2000));
      console.log(`[instagram/profile] ${username}: Puppeteer ${userData ? 'OK' : 'failed'}`);
    } catch (err) {
      console.error(`[instagram/profile] Puppeteer error for ${username}:`, err.message);
    } finally {
      await page.close();
      await browser.close();
    }
  }

  if (!userData) {
    return res.status(404).json({ error: 'Profile not found or blocked' });
  }

  res.json(toIGProfile(userData));
});

// ─── POST /instagram/listup ───────────────────────────────────────────────────
// 해시태그 기반 Instagram 인플루언서 발굴
// Body: { hashtag: string, limit?: number, minFollowers?: number, maxFollowers?: number }
// Returns: { accounts: InstagramAccount[], hitLimit: boolean }
app.post('/instagram/listup', async (req, res) => {
  const {
    hashtag,
    limit = 50,
    minFollowers = 1000,
    maxFollowers = 100000,
  } = req.body;
  if (!hashtag) return res.status(400).json({ error: 'hashtag required' });

  const cleanTag = hashtag.replace(/^#/, '');
  const discoveredUsernames = new Set();

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });

    // GraphQL 응답에서 게시물 작성자 username 수집
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('graphql') && !url.includes('/api/v1/')) return;
      try {
        const json = await response.json();
        const edges =
          json?.data?.hashtag?.edge_hashtag_to_media?.edges ??
          json?.data?.recent_media?.edges ??
          [];
        for (const { node } of edges) {
          if (node?.owner?.username) discoveredUsernames.add(node.owner.username);
        }
      } catch {}
    });

    await page.goto(`https://www.instagram.com/explore/tags/${cleanTag}/`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // 스크롤로 더 많은 게시물 노출
    let prevCount = 0;
    for (let i = 0; i < 8; i++) {
      if (discoveredUsernames.size >= limit * 3) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 2000));
      if (discoveredUsernames.size === prevCount) break;
      prevCount = discoveredUsernames.size;
    }

    // DOM에서 추가 username 추출 (GraphQL 차단 대비)
    const domUsernames = await page.$$eval('a[href^="/"]', els =>
      els
        .map(el => (el.getAttribute('href') || '').replace(/\//g, ''))
        .filter(s => s && /^[a-zA-Z0-9._]{3,30}$/.test(s))
    );
    domUsernames.forEach(u => discoveredUsernames.add(u));

    console.log(`[instagram/listup] #${cleanTag}: ${discoveredUsernames.size} usernames discovered`);
  } catch (err) {
    console.error(`[instagram/listup] Error:`, err.message);
  } finally {
    await page.close();
    await browser.close();
  }

  // 발굴된 username별 프로필 조회 → 팔로워 필터 적용
  const accounts = [];
  let hitLimit = false;
  const toCheck = Array.from(discoveredUsernames).slice(0, limit * 4);

  for (const username of toCheck) {
    if (accounts.length >= limit) { hitLimit = true; break; }

    const userData = await fetchIGProfileAPI(username);
    if (!userData) {
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    const followers = userData.edge_followed_by?.count ?? 0;
    if (followers < minFollowers || followers > maxFollowers) continue;

    const bio = userData.biography ?? '';
    accounts.push({
      username: userData.username,
      fullName: userData.full_name ?? '',
      biography: bio,
      followersCount: followers,
      followsCount: userData.edge_follow?.count ?? 0,
      profilePicUrl: userData.profile_pic_url_hd ?? userData.profile_pic_url ?? '',
      contactEmail: extractEmail(bio),
      instagramLink: `https://www.instagram.com/${userData.username}/`,
    });

    await new Promise(r => setTimeout(r, 500)); // 레이트 리밋 방지
  }

  console.log(`[instagram/listup] #${cleanTag}: ${accounts.length} accounts found (limit=${limit})`);
  res.json({ accounts, hitLimit: hitLimit || toCheck.length >= limit * 4 });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[crawler] Listening on port ${PORT}`));
