const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVideoSearchIntent,
  rankRealtimeVideos,
} = require('../video-search');

test('extracts a clean topic from a student video request', () => {
  const intent = buildVideoSearchIntent('can u get me a video for modes of nutrition grade 6', 'Science', 6);

  assert.equal(intent.topicText, 'modes of nutrition');
  assert.equal(intent.topicLabel, 'Modes of Nutrition');
  assert.match(intent.query, /^modes of nutrition science grade 6 school lesson$/);
  assert.deepEqual(intent.topicTerms, ['mode', 'nutrition']);
});

test('normalizes common topic spelling mistakes before searching videos', () => {
  const intent = buildVideoSearchIntent('get me video of photo synthsis', 'Science', 6);

  assert.equal(intent.topicText, 'photosynthesis');
  assert.equal(intent.topicLabel, 'Photosynthesis');
  assert.match(intent.query, /^photosynthesis science grade 6 school lesson$/);
  assert.deepEqual(intent.topicTerms, ['photosynthesi']);
});

test('ranks exact topic videos above broad chapter videos', () => {
  const intent = buildVideoSearchIntent('video for modes of nutrition', 'Science', 6);
  const ranked = rankRealtimeVideos([
    {
      title: 'Components of Food Grade 6 Science Chapter 2 Full Chapter | Learnfatafat',
      source: 'LearnFatafat',
      description: 'Food components and nutrients for class 6.',
      durationSeconds: 1260,
      viewCount: 800000,
    },
    {
      title: 'Modes of Nutrition | Heterotrophic & Autotrophic | Biology | Science | Letstute',
      source: "Let'stute",
      description: 'Learn autotrophic and heterotrophic modes of nutrition.',
      durationSeconds: 420,
      viewCount: 90000,
    },
  ], intent);

  assert.equal(ranked.length, 1);
  assert.match(ranked[0].title, /Modes of Nutrition/);
  assert.ok(ranked[0].topicMatchScore >= 80);
});

test('keeps focused math videos for exact formula topics', () => {
  const intent = buildVideoSearchIntent('get me a video to learn pythagorean theorem', 'Maths', 8);
  const ranked = rankRealtimeVideos([
    {
      title: 'Geometry Full Chapter Class 8 One Shot',
      source: 'Example Channel',
      description: 'Complete geometry chapter.',
      durationSeconds: 3000,
      viewCount: 200000,
    },
    {
      title: 'Pythagorean Theorem Explained with Examples',
      source: 'Khan Academy',
      description: 'Right triangles and hypotenuse practice.',
      durationSeconds: 600,
      viewCount: 1000000,
    },
  ], intent);

  assert.equal(ranked[0].title, 'Pythagorean Theorem Explained with Examples');
  assert.equal(ranked.length, 1);
});

test('demotes exact-topic videos when they clearly target the wrong grade', () => {
  const intent = buildVideoSearchIntent('get me a video for modes of nutrition grade 6', 'Science', 6);
  const ranked = rankRealtimeVideos([
    {
      title: 'Nutrition in Plants Class 7 Science | Modes of Nutrition in Plants',
      source: 'LearnFatafat',
      description: 'Autotrophic and heterotrophic nutrition in plants.',
      durationSeconds: 600,
      viewCount: 500000,
    },
    {
      title: 'Modes of Nutrition | Heterotrophic & Autotrophic | Biology | Science',
      source: "Let'stute",
      description: 'School science lesson on modes of nutrition.',
      durationSeconds: 420,
      viewCount: 90000,
    },
  ], intent);

  assert.match(ranked[0].title, /^Modes of Nutrition/);
});

test('keeps photosynthesis videos when the student misspells the topic', () => {
  const intent = buildVideoSearchIntent('get me video of photosynthsis', 'Science', 6);
  const ranked = rankRealtimeVideos([
    {
      title: 'Photosynthesis | Educational Video for Kids',
      source: 'Happy Learning English',
      description: 'Plants make food using sunlight, water, and carbon dioxide.',
      durationSeconds: 360,
      viewCount: 300000,
    },
  ], intent);

  assert.equal(ranked.length, 1);
  assert.match(ranked[0].title, /Photosynthesis/);
});
