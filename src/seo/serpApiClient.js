// serpApiClient.js
// SerpAPI client for local SEO — Google Maps rankings, reviews, competitor analysis

require("dotenv").config({ quiet: true });
const axios = require("axios");

const API_KEY = process.env.SERPAPI_KEY;
const BASE_URL = "https://serpapi.com/search.json";

// Studio AZ coordinates (North Loop, Minneapolis)
const STUDIO_AZ_LAT = 44.9842902;
const STUDIO_AZ_LNG = -93.2738897;

const BUSINESS_NAMES = {
  barbershop: "Studio AZ",
  tattoo: "Studio AZ Tattoo",
};

/**
 * Search Google Maps for a keyword in Minneapolis and return ranked results.
 *
 * @param {string} keyword - e.g. "barbershop near me"
 * @param {object} options
 * @param {string} options.location - GPS coords as "lat,lng" (default: Studio AZ location)
 * @param {number} options.zoom - Map zoom level (default: 14 for neighborhood-level)
 */
async function searchGoogleMaps(keyword, options = {}) {
  const params = {
    engine: "google_maps",
    q: keyword,
    ll: options.location || `@${STUDIO_AZ_LAT},${STUDIO_AZ_LNG},${options.zoom || 14}z`,
    type: "search",
    api_key: API_KEY,
  };

  const resp = await axios.get(BASE_URL, { params, timeout: 30000 });
  const results = resp.data.local_results || [];

  return results.map((r, idx) => ({
    position: idx + 1,
    name: r.title,
    rating: r.rating,
    reviewCount: r.reviews,
    address: r.address,
    phone: r.phone,
    website: r.website,
    type: r.type,
    hours: r.hours,
    thumbnail: r.thumbnail,
    placeId: r.place_id,
    gpsCoordinates: r.gps_coordinates,
  }));
}

/**
 * Search Google and extract Local Pack results for a keyword.
 */
async function searchLocalPack(keyword, options = {}) {
  const params = {
    engine: "google",
    q: keyword,
    location: options.location || "Minneapolis, Minnesota, United States",
    google_domain: "google.com",
    gl: "us",
    hl: "en",
    api_key: API_KEY,
  };

  const resp = await axios.get(BASE_URL, { params, timeout: 30000 });
  const localPack = resp.data.local_results?.places || resp.data.local_results || [];

  return {
    localPack: Array.isArray(localPack)
      ? localPack.map((r, idx) => ({
          position: idx + 1,
          name: r.title,
          rating: r.rating,
          reviewCount: r.reviews,
          address: r.address,
          type: r.type,
          placeId: r.place_id,
        }))
      : [],
    organicResults: (resp.data.organic_results || []).slice(0, 10).map((r, idx) => ({
      position: idx + 1,
      title: r.title,
      link: r.link,
      snippet: r.snippet,
      displayedLink: r.displayed_link,
    })),
    searchInfo: {
      totalResults: resp.data.search_information?.total_results,
      timeTaken: resp.data.search_information?.time_taken_displayed,
    },
  };
}

/**
 * Get all Google reviews for a business.
 *
 * @param {string} placeId - Google Maps place_id (from searchGoogleMaps)
 */
async function getReviews(placeId) {
  const params = {
    engine: "google_maps_reviews",
    place_id: placeId,
    api_key: API_KEY,
    sort_by: "newestFirst",
  };

  const resp = await axios.get(BASE_URL, { params, timeout: 30000 });
  const placeInfo = resp.data.place_info || {};
  const reviews = resp.data.reviews || [];

  return {
    business: {
      name: placeInfo.title,
      address: placeInfo.address,
      rating: placeInfo.rating,
      totalReviews: placeInfo.reviews,
    },
    reviews: reviews.map((r) => ({
      author: r.user?.name,
      rating: r.rating,
      date: r.date,
      snippet: r.snippet,
      likes: r.likes,
      isLocalGuide: r.user?.local_guide,
      response: r.response?.snippet || null,
    })),
  };
}

/**
 * Get Google search autocomplete suggestions for a partial query.
 * Reveals what real people type when they start a search — gold mine for
 * keyword research and content topic discovery.
 *
 * @param {string} partial - Partial query, e.g. "tattoo shop minneap"
 * @param {object} options
 * @param {string} options.location - Geo bias (default: Minneapolis)
 */
async function googleAutocomplete(partial, options = {}) {
  const params = {
    engine: "google_autocomplete",
    q: partial,
    gl: "us",
    hl: "en",
    api_key: API_KEY,
  };

  const resp = await axios.get(BASE_URL, { params, timeout: 30000 });
  const suggestions = resp.data.suggestions || [];

  return {
    query: partial,
    suggestions: suggestions.map((s, idx) => ({
      position: idx + 1,
      value: s.value,
      relevance: s.relevance,
      type: s.type, // "QUERY" or "NAVIGATION" etc.
    })),
  };
}

/**
 * Get "People Also Ask" related questions for a Google search.
 * Each question is a content opportunity — Google literally tells you
 * what your audience wants answered.
 *
 * @param {string} query - The search query
 * @param {object} options
 */
async function googleRelatedQuestions(query, options = {}) {
  const params = {
    engine: "google",
    q: query,
    location: options.location || "Minneapolis, Minnesota, United States",
    google_domain: "google.com",
    gl: "us",
    hl: "en",
    api_key: API_KEY,
  };

  const resp = await axios.get(BASE_URL, { params, timeout: 30000 });
  const paa = resp.data.related_questions || [];
  const relatedSearches = resp.data.related_searches || [];

  return {
    query,
    peopleAlsoAsk: paa.map((q) => ({
      question: q.question,
      snippet: q.snippet,
      title: q.title,
      link: q.link,
      source: q.displayed_link,
    })),
    relatedSearches: relatedSearches.map((r) => r.query).filter(Boolean),
  };
}

/**
 * Get Google Trends data for one or more keywords.
 * Useful for catching seasonality (when does tattoo demand spike?) and
 * timing campaigns / content launches.
 *
 * @param {string|string[]} keywords - One or up to 5 keywords (Google Trends limit)
 * @param {object} options
 * @param {string} options.geo - Geographic restriction (default: "US-MN" for Minnesota)
 * @param {string} options.dateRange - "today 1-m" | "today 3-m" | "today 12-m" | "today 5-y"
 * @param {string} options.dataType - "TIMESERIES" (default), "GEO_MAP", "RELATED_QUERIES"
 */
async function googleTrends(keywords, options = {}) {
  const q = Array.isArray(keywords) ? keywords.join(",") : keywords;
  const params = {
    engine: "google_trends",
    q,
    geo: options.geo || "US-MN",
    date: options.dateRange || "today 12-m",
    data_type: options.dataType || "TIMESERIES",
    api_key: API_KEY,
  };

  const resp = await axios.get(BASE_URL, { params, timeout: 30000 });
  return {
    keywords: Array.isArray(keywords) ? keywords : [keywords],
    geo: params.geo,
    dateRange: params.date,
    interestOverTime: resp.data.interest_over_time || null,
    interestByRegion: resp.data.interest_by_region || null,
    relatedQueries: resp.data.related_queries || null,
    relatedTopics: resp.data.related_topics || null,
  };
}

/**
 * Search Yelp and return business listings + Studio AZ's position if found.
 *
 * @param {string} keyword - e.g. "tattoo"
 * @param {object} options
 * @param {string} options.location - default "Minneapolis, MN, USA"
 * @param {string} options.findDesc - Find description (defaults to keyword)
 */
async function searchYelp(keyword, options = {}) {
  const params = {
    engine: "yelp",
    find_desc: options.findDesc || keyword,
    find_loc: options.location || "Minneapolis, MN, USA",
    api_key: API_KEY,
  };

  const resp = await axios.get(BASE_URL, { params, timeout: 30000 });
  const results = resp.data.organic_results || [];

  return {
    keyword,
    location: params.find_loc,
    totalResults: results.length,
    results: results.map((r, idx) => ({
      position: idx + 1,
      name: r.title,
      yelpUrl: r.link,
      rating: r.rating,
      reviewCount: r.reviews,
      neighborhoods: r.neighborhoods,
      categories: r.categories,
      phone: r.phone,
      price: r.price,
      placeIdsId: r.place_ids?.[0],
    })),
  };
}

/**
 * Search YouTube for a query and return video results. Useful for checking
 * whether your social/portfolio video content is discoverable in YouTube
 * search (and Google Video search by extension).
 *
 * @param {string} keyword - e.g. "fine line tattoo minneapolis"
 */
async function searchYouTube(keyword) {
  const params = {
    engine: "youtube",
    search_query: keyword,
    api_key: API_KEY,
  };

  const resp = await axios.get(BASE_URL, { params, timeout: 30000 });
  const videos = resp.data.video_results || [];
  const channels = resp.data.channel_results || [];

  return {
    keyword,
    videoCount: videos.length,
    videos: videos.slice(0, 20).map((v, idx) => ({
      position: idx + 1,
      title: v.title,
      link: v.link,
      channel: v.channel?.name,
      channelLink: v.channel?.link,
      views: v.views,
      published: v.published_date,
      length: v.length,
      description: v.description,
    })),
    channels: channels.slice(0, 5).map((c) => ({
      name: c.title,
      link: c.link,
      subscribers: c.subscribers,
      verified: c.verified,
    })),
  };
}

/**
 * Find Studio AZ's position in Google Maps results for a keyword.
 *
 * @param {string} keyword - Search keyword
 * @param {string} siteKey - "barbershop" or "tattoo"
 * @returns {object} - { found, position, totalResults, competitors }
 */
async function findRankingPosition(keyword, siteKey) {
  const results = await searchGoogleMaps(keyword);
  const businessName = BUSINESS_NAMES[siteKey] || "Studio AZ";

  const match = results.find((r) =>
    r.name.toLowerCase().includes(businessName.toLowerCase())
  );

  return {
    keyword,
    business: businessName,
    found: !!match,
    position: match ? match.position : null,
    rating: match ? match.rating : null,
    reviewCount: match ? match.reviewCount : null,
    totalResults: results.length,
    topCompetitors: results.filter((r) => !r.name.toLowerCase().includes(businessName.toLowerCase())).slice(0, 5),
  };
}

/**
 * Track rankings for multiple keywords at once.
 *
 * @param {string[]} keywords - Array of keywords to check
 * @param {string} siteKey - "barbershop" or "tattoo"
 */
async function trackKeywordRankings(keywords, siteKey) {
  const results = [];
  for (const keyword of keywords) {
    try {
      const ranking = await findRankingPosition(keyword, siteKey);
      results.push(ranking);
    } catch (err) {
      results.push({ keyword, error: err.message });
    }
  }
  return results;
}

/**
 * Run a full competitor analysis for a business type.
 * Searches multiple keywords and identifies recurring competitors.
 *
 * @param {string} siteKey - "barbershop" or "tattoo"
 * @param {string[]} keywords - Keywords to analyze
 */
async function competitorAnalysis(siteKey, keywords) {
  const allResults = [];
  const competitorMap = {};

  for (const keyword of keywords) {
    try {
      const results = await searchGoogleMaps(keyword);
      const businessName = BUSINESS_NAMES[siteKey] || "Studio AZ";

      const studioPosition = results.findIndex((r) =>
        r.name.toLowerCase().includes(businessName.toLowerCase())
      );

      allResults.push({
        keyword,
        studioAzPosition: studioPosition >= 0 ? studioPosition + 1 : "Not found",
        topResults: results.slice(0, 5).map((r) => r.name),
      });

      // Track competitor frequency
      for (const r of results) {
        if (r.name.toLowerCase().includes(businessName.toLowerCase())) continue;
        if (!competitorMap[r.name]) {
          competitorMap[r.name] = {
            name: r.name,
            rating: r.rating,
            reviewCount: r.reviewCount,
            address: r.address,
            website: r.website,
            keywordsAppearedIn: [],
            positions: [],
          };
        }
        competitorMap[r.name].keywordsAppearedIn.push(keyword);
        const pos = results.findIndex((x) => x.name === r.name);
        if (pos >= 0) competitorMap[r.name].positions.push(pos + 1);
      }
    } catch (err) {
      allResults.push({ keyword, error: err.message });
    }
  }

  // Sort competitors by frequency (most appearances first)
  const competitors = Object.values(competitorMap)
    .map((c) => ({
      ...c,
      frequency: c.keywordsAppearedIn.length,
      avgPosition: Math.round((c.positions.reduce((a, b) => a + b, 0) / c.positions.length) * 10) / 10,
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 15);

  return {
    business: BUSINESS_NAMES[siteKey],
    keywordsAnalyzed: keywords.length,
    rankingsByKeyword: allResults,
    topCompetitors: competitors,
    searchesUsed: keywords.length,
  };
}

module.exports = {
  searchGoogleMaps,
  searchLocalPack,
  getReviews,
  googleAutocomplete,
  googleRelatedQuestions,
  googleTrends,
  searchYelp,
  searchYouTube,
  findRankingPosition,
  trackKeywordRankings,
  competitorAnalysis,
};
