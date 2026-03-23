// serpApiClient.js
// SerpAPI client for local SEO — Google Maps rankings, reviews, competitor analysis

require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.SERPAPI_KEY;
const BASE_URL = "https://serpapi.com/search.json";

// Studio AZ coordinates (North Loop, Minneapolis)
const STUDIO_AZ_LAT = 44.9868;
const STUDIO_AZ_LNG = -93.2779;

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
  findRankingPosition,
  trackKeywordRankings,
  competitorAnalysis,
};
