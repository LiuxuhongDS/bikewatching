// Import Mapbox as an ESM module
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Check that Mapbox GL JS is loaded
console.log('Mapbox GL JS Loaded:', mapboxgl);

// Set your Mapbox access token here
mapboxgl.accessToken = 'pk.eyJ1IjoibGl1eHVob25nIiwiYSI6ImNtcDdhemYxYTAwOGIydXBycDBrcGNkMTYifQ.1-anvwta6ioa6di0jzReKw';

// Initialize the map
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// Select the SVG overlay inside the map container
const svg = d3.select('#map').select('svg');

// Pre-bucketed trips by minute (1440 minutes in a day)
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// Global time filter state
let timeFilter = -1;

// Radius scale (will be updated dynamically)
const radiusScale = d3.scaleSqrt().domain([0, 0]).range([0, 25]);

// Quantize scale for departure ratio → 3 discrete values
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// ── Helper: Convert lon/lat to pixel coordinates ──────────────────────────────
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// ── Helper: Format minutes since midnight → HH:MM AM/PM ──────────────────────
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// ── Helper: Get minutes since midnight from a Date object ─────────────────────
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// ── Efficient trip filter using pre-bucketed arrays ───────────────────────────
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

// ── Compute station traffic (arrivals, departures, totalTraffic) ──────────────
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    let id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// ── Map load ──────────────────────────────────────────────────────────────────
map.on('load', async () => {

  // Step 2: Add Boston bike lanes
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network.geojson',
  });

  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: {
      'line-color': '#32D400',
      'line-width': 3,
      'line-opacity': 0.5,
    },
  });

  // Step 2.3: Add Cambridge bike lanes
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });

  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: {
      'line-color': '#32D400',
      'line-width': 3,
      'line-opacity': 0.5,
    },
  });

  // Step 3: Load station data
  let jsonData;
  try {
    const jsonurl = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
    jsonData = await d3.json(jsonurl);
    console.log('Loaded JSON Data:', jsonData);
  } catch (error) {
    console.error('Error loading JSON:', error);
    return;
  }

  let stations = jsonData.data.stations;
  console.log('Stations Array:', stations);

  // Step 4.1: Load and parse traffic data, converting timestamps and bucketing
  let trips = await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);

      // Step 5.4: Pre-bucket trips by minute
      let startedMinutes = minutesSinceMidnight(trip.started_at);
      let endedMinutes = minutesSinceMidnight(trip.ended_at);
      departuresByMinute[startedMinutes].push(trip);
      arrivalsByMinute[endedMinutes].push(trip);

      return trip;
    },
  );

  console.log('Trips loaded:', trips.length);

  // Compute initial station traffic (all trips)
  stations = computeStationTraffic(stations);

  // Update radius scale domain
  radiusScale.domain([0, d3.max(stations, (d) => d.totalTraffic)]);

  // Step 3.3: Create SVG circles for each station
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) =>
      stationFlow(d.departures / d.totalTraffic),
    )
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
        );
    });

  // ── Update circle positions when map moves ──────────────────────────────────
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();

  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // ── Step 5.3: Update scatterplot based on time filter ──────────────────────
  function updateScatterPlot(timeFilter) {
    // Adjust radius range based on whether filtering is applied
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    // Recompute station traffic using filtered trips
    const filteredStations = computeStationTraffic(stations, timeFilter);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        stationFlow(d.departures / d.totalTraffic),
      );

    updatePositions();
  }

  // ── Step 5.2: Slider reactivity ────────────────────────────────────────────
  const timeSlider = document.querySelector('#time-slider');
  const selectedTime = document.querySelector('#selected-time');
  const anyTimeLabel = document.querySelector('#any-time');

  function updateTimeDisplay() {
    timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
