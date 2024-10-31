import * as cheerio from 'cheerio';
import UserAgent from 'user-agents';

// Synthetic headers to mimic a real browser for Letterboxd scraping
const userAgent = new UserAgent({ deviceCategory: 'desktop' });
const LETTERBOXD_HEADERS = {
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.5',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Priority': 'u=1, i',
  'Referer': 'https://letterboxd.com/',
  'sec-ch-ua': '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'User-Agent': userAgent.toString(),
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
}

// Helper function to extract page count from Letterboxd HTML
function getPageCountFromHtml(html) {
  const $ = cheerio.load(html);
  const pageCount = $('.paginate-pages li.paginate-page').length;
  return pageCount;
}

// Helper function to extract user data from Letterboxd HTML
function getUserDataFromHtml(html) {
  const $ = cheerio.load(html);

  // Extract user's name from title and clean it up
  // Format is: "&lrm;Bob's film diary • Letterboxd"
  const pageTitle = $('title').text().trim();
  let name = pageTitle.split('’')[0].trim();
  name = name.substring(1);

  // Extract profile picture URL and modify URL to get a larger size
  // If they haven't set a profile picture, we return null and the app can use a placeholder
  let profilePicUrl = $('.profile-mini-person .avatar img').attr('src');
  if (profilePicUrl && profilePicUrl.includes('-0-48-0-48-crop')) {
    profilePicUrl = profilePicUrl.replace('-0-48-0-48-crop', '-0-220-0-220-crop');
  } else {
    profilePicUrl = null;
  }

  return { name, profilePicUrl };
}

// Helper function to extract structured movie data from Letterboxd HTML
function getMovieDataFromHtml(html) {
  const $ = cheerio.load(html);
  const movies = [];

  $('tr.diary-entry-row').each((_, row) => {
    const $row = $(row);

    // Extract the film div where data attributes are stored
    const $filmDiv = $row.find('td.td-film-details div[data-film-id]');

    // Extract the film ID and film slug
    const filmId = $filmDiv.attr('data-film-id') ? $filmDiv.attr('data-film-id').trim() : null;
    const filmSlug = $filmDiv.attr('data-film-slug') ? stripYearFromSlug($filmDiv.attr('data-film-slug').trim()) : null;

    // Extract the movie title from the h3 element
    const title = $row.find('td.td-film-details h3.headline-3 a').text().trim();

    // Construct the poster URL slug from the filmId
    let posterUrl = null;
    if (filmId && filmSlug) {
      const idDigits = filmId.split('');
      const path = idDigits.join('/');
      posterUrl = `https://a.ltrbxd.com/resized/film-poster/${path}/${filmId}-${filmSlug}-0-300-0-450-crop.jpg`;
    }

    // Extract and reconstruct the watch date from the URL
    let watchDate = null;
    const dateUrl = $row.find('td.td-day a').attr('href');
    if (dateUrl) {
      const dateParts = dateUrl.split('/').filter(Boolean);
      const forIndex = dateParts.indexOf('for');
      if (forIndex !== -1 && dateParts.length > forIndex + 3) {
        const year = dateParts[forIndex + 1];
        const month = dateParts[forIndex + 2];
        const day = dateParts[forIndex + 3];
        watchDate = new Date(`${year}-${month}-${day}`);
      }
    }

    // Extract the star rating
    let rating = null;
    const ratingValue = $row.find('td.td-rating input.rateit-field').attr('value');
    if (ratingValue !== undefined) {
      rating = parseInt(ratingValue, 10);
    }

    // Determine if the movie is liked
    const isLiked = $row.find('td.td-like .icon-liked').length > 0;

    // Construct the movie object
    movies.push({ filmId, title, posterUrl, watchDate, rating, isLiked });
  });

  return { movies };
}

// Helper function to strip the year from the slug to get the correct poster URL
function stripYearFromSlug(slug) {
  if (slug && slug.length >= 5) {
    const lastHyphenIndex = slug.lastIndexOf('-');
    if (lastHyphenIndex !== -1) {
      const possibleYear = slug.slice(lastHyphenIndex + 1);
      if (possibleYear.length === 4 && !isNaN(possibleYear)) {
        return slug.slice(0, lastHyphenIndex);
      }
    }
  }
  return slug;
}

export async function handler(event) {

  if (!event.queryStringParameters || !event.queryStringParameters.url) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "No URL provided" }),
    };
  }

  const { url } = event.queryStringParameters;

  console.log('Server received URL:', url);

  // Disallow proxying to arbitrary URLs
  if (!url || !url.startsWith("https://letterboxd.com/")) {
      return {
          statusCode: 400,
          body: JSON.stringify({ error: "Invalid URL" }),
      };
  }

  try {
      const firstPageResponse = await fetch(url, {
          headers: LETTERBOXD_HEADERS
      });

      const firstPageHtml = await firstPageResponse.text();

      const pageCount = getPageCountFromHtml(firstPageHtml);
      const { name, profilePicUrl } = getUserDataFromHtml(firstPageHtml);
      const { movies } = getMovieDataFromHtml(firstPageHtml);

      // Prepare URLs for paginated requests
      const pageUrls = [];
      for (let i = 2; i <= pageCount; i++) {
        pageUrls.push(`${url}page/${i}/`);
      }

      // Fetch all additional pages concurrently
      const paginatedMovies = await Promise.all(
        pageUrls.map(pageUrl => 
          fetch(pageUrl, { headers: LETTERBOXD_HEADERS })
            .then(res => res.text())
            .then(html => getMovieDataFromHtml(html))
        )
      );

      // Combine all movies from all pages
      const allMovies = [
        ...movies,
        ...paginatedMovies.flatMap(pageData => pageData.movies)
      ];

      return {
        statusCode: firstPageResponse.status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            // Allow Netlify to cache responses
            'Netlify-CDN-Cache-Control': `public, s-maxage=${60*60*24}, stale-while-revalidate=${60*60*48}, durable`,
            // Optional cache tags for selective purging
            'Netlify-Cache-Tag': 'letterboxd-diary'
        },
        body: JSON.stringify({ movies: allMovies, name, profilePicUrl }),
    };
  } catch (e) {
      return {
          statusCode: 500,
          body: JSON.stringify({ error: `Failed to fetch data: ${e}` }),
      };
  }
}