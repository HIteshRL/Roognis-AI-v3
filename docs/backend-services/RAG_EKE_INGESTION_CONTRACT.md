# Educational Knowledge Engine Ingestion Contract

Service path: `services/rag`

Status: design contract for the EKE ingestion PR

## Purpose

The RAG service will become the Educational Knowledge Engine (EKE) for Roognis. The service still owns `/api/rag/*` for compatibility with the existing AI service and gateway, but internally it should model curriculum knowledge as educational entities first and retrieval chunks second.

The graph/entity layer is the source of truth. Vector chunks are generated indexes over that source of truth.

## Compatibility Rules

- Keep `/api/rag/retrieve` compatible with the AI service.
- Return chunks with at least `text`, `source`, and optional `score`.
- New responses may include richer fields such as `chunkId`, `entityId`, `metadata`, and `pedagogicalOrder`.
- Teacher ingestion APIs require a teacher JWT cookie.
- `/api/rag/retrieve` remains callable by the AI service without a JWT, using explicit `schoolId` and metadata filters.
- Prefer the existing service stub names:
  - `POST /api/rag/upload`
  - `GET /api/rag/upload/:docId/status`
  - `GET /api/rag/documents`
  - `GET /api/rag/retrieve`
- Older docs may mention `POST /api/rag/documents`; if kept, it should be an alias for `POST /api/rag/upload`, not a second workflow.

## Document Lifecycle

Documents move through explicit states:

```text
uploaded
queued
parsing
structuring
classifying
graph_building
chunking
embedding
indexed
ready
failed
```

State meanings:

| Status | Meaning |
|---|---|
| `uploaded` | The file and metadata were accepted and persisted. |
| `queued` | The ingestion job is waiting to run. |
| `parsing` | The PDF is being converted into pages, text blocks, tables, figures, captions, and reading order. |
| `structuring` | Parsed blocks are being mapped into book, chapter, section, subsection, and object hierarchy. |
| `classifying` | Educational objects are being classified. |
| `graph_building` | Canonical concepts, entities, hierarchy, and relationships are being written. |
| `chunking` | Retrieval chunks are being generated from entities and relationships. |
| `embedding` | Chunks are being embedded and prepared for vector storage. |
| `indexed` | Dense or lexical indexes have been written successfully. |
| `ready` | The document is available for retrieval. |
| `failed` | Processing stopped; `errorMessage` must describe the failure. |

Terminal states:

- `ready`
- `failed`

Retry behavior:

- A failed document may be retried by setting status back to `queued`.
- Re-ingestion should be idempotent by document ID and should replace chunks/index entries for that document before writing new ones.

## Metadata Schema

Document-level metadata is required on upload and inherited by every entity, chunk, embedding payload, and graph node.

Required fields:

```json
{
  "board": "CBSE",
  "curriculum": "NCERT",
  "grade": 8,
  "subject": "Science",
  "book": "Curiosity",
  "chapterNumber": 10,
  "chapterName": "Light: Mirrors and Lenses",
  "language": "English",
  "edition": "2026-27"
}
```

Optional fields:

```json
{
  "schoolId": "uuid-from-jwt",
  "section": "10.2",
  "difficulty": "Easy",
  "sourceType": "ncert_textbook",
  "sourceUrl": "https://...",
  "isbn": "optional",
  "license": "optional",
  "tags": ["mirrors", "lenses"]
}
```

Validation rules:

- `schoolId` comes from the teacher JWT and must not be trusted from browser form data.
- `grade` must be an integer from 1 to 12.
- `subject`, `book`, `chapterName`, and `language` are non-empty strings.
- `chapterNumber` is a positive integer.
- `board`, `curriculum`, and `language` should be normalized before storage.
- Metadata values should be copied into vector payloads so filtering happens before dense retrieval.

Canonical normalized metadata shape:

```json
{
  "schoolId": "uuid",
  "board": "CBSE",
  "curriculum": "NCERT",
  "grade": 8,
  "subject": "Science",
  "book": "Curiosity",
  "chapterNumber": 10,
  "chapterName": "Light: Mirrors and Lenses",
  "language": "English",
  "edition": "2026-27",
  "section": "10.2",
  "difficulty": "Easy",
  "pageStart": 155,
  "pageEnd": 157
}
```

## Educational Object Types

Supported entity object types:

```text
CanonicalConcept
Concept
Definition
Activity
Experiment
Observation
Conclusion
Example
Application
Figure
Diagram
Table
Summary
Law
Formula
Exercise
Question
Safety
Extension
KeyPoint
```

Canonical concepts are first-class nodes. Textbook artifacts link to canonical concepts instead of all objects being treated as peers.

Example:

```text
CanonicalConcept: Concave Mirror
  HAS_DEFINITION -> Definition
  HAS_EXPLANATION -> Concept
  ILLUSTRATED_BY -> Figure
  USED_IN -> Application
  HAS_PRACTICE -> Exercise
```

## Entity Shape

Entities are primary storage records for educational knowledge.

```json
{
  "entityId": "uuid",
  "documentId": "uuid",
  "entityType": "Concept",
  "canonicalConceptId": "uuid-or-null",
  "title": "Concave Mirror",
  "content": "A concave mirror is...",
  "summary": "Concave mirrors curve inward and can form enlarged images.",
  "metadata": {
    "schoolId": "uuid",
    "board": "CBSE",
    "curriculum": "NCERT",
    "grade": 8,
    "subject": "Science",
    "book": "Curiosity",
    "chapterNumber": 10,
    "chapterName": "Light: Mirrors and Lenses",
    "section": "10.2",
    "pageStart": 155,
    "pageEnd": 156,
    "difficulty": "Easy",
    "language": "English"
  },
  "parentId": "uuid-or-null",
  "childIds": ["uuid"],
  "relationships": [
    {
      "type": "ILLUSTRATED_BY",
      "targetEntityId": "uuid",
      "confidence": 0.91
    }
  ],
  "embeddingIds": ["vector-id"],
  "chunkIds": ["uuid"],
  "createdAt": "2026-07-10T00:00:00.000Z",
  "updatedAt": "2026-07-10T00:00:00.000Z"
}
```

Required relationship types:

```text
BELONGS_TO
HAS_CHILD
HAS_PARENT
RELATED_TO
PREREQUISITE
ILLUSTRATED_BY
EXPLAINED_BY
USED_IN
APPLICATION_OF
EXAMPLE_OF
CAUSES
RESULTS_IN
COMPARES_WITH
NEXT_TOPIC
PREVIOUS_TOPIC
REFERENCES
SUMMARIZED_BY
```

## Chunk Shape

Chunks are retrieval artifacts generated after graph/entity construction.

```json
{
  "chunkId": "uuid",
  "documentId": "uuid",
  "entityId": "uuid",
  "canonicalConceptId": "uuid-or-null",
  "chunkType": "semantic",
  "text": "Concave mirrors curve inward. They can form enlarged images...",
  "source": "NCERT Science Grade 8, Curiosity, Chapter 10, p.155",
  "metadata": {
    "schoolId": "uuid",
    "board": "CBSE",
    "curriculum": "NCERT",
    "grade": 8,
    "subject": "Science",
    "book": "Curiosity",
    "chapterNumber": 10,
    "chapterName": "Light: Mirrors and Lenses",
    "section": "10.2",
    "pageStart": 155,
    "pageEnd": 156,
    "entityType": "Concept",
    "language": "English",
    "difficulty": "Easy"
  },
  "pedagogicalOrder": 30,
  "embeddingId": "vector-id",
  "tokenCount": 164,
  "createdAt": "2026-07-10T00:00:00.000Z"
}
```

Chunk generation rules:

- Concepts may combine definition, explanation, example, and figure caption into one semantic chunk.
- Activities should produce one parent chunk plus child chunks for materials, procedure, observation, and principle.
- Exercises should produce one chunk per question.
- Figures and diagrams should produce one chunk that includes caption, nearby explanation, page, and linked concept.
- Chunks must carry enough metadata to support pre-retrieval filtering.

## API Contract

### `POST /api/rag/upload`

Role: teacher

Content type: `multipart/form-data`

Form fields:

| Field | Required | Notes |
|---|---:|---|
| `file` | yes | PDF file. |
| `board` | yes | Example: `CBSE`. |
| `curriculum` | yes | Example: `NCERT`. |
| `grade` | yes | Integer 1 to 12. |
| `subject` | yes | Example: `Science`. |
| `book` | yes | Example: `Curiosity`. |
| `chapterNumber` | yes | Positive integer. |
| `chapterName` | yes | Human readable chapter title. |
| `language` | yes | Example: `English`. |
| `edition` | yes | Example: `2026-27`. |
| `difficulty` | no | Default can be inferred later. |
| `tags` | no | Comma-separated list or JSON array. |

Response:

```json
{
  "documentId": "uuid",
  "status": "queued",
  "metadata": {
    "schoolId": "uuid",
    "board": "CBSE",
    "curriculum": "NCERT",
    "grade": 8,
    "subject": "Science",
    "book": "Curiosity",
    "chapterNumber": 10,
    "chapterName": "Light: Mirrors and Lenses",
    "language": "English",
    "edition": "2026-27"
  }
}
```

### `GET /api/rag/upload/:docId/status`

Role: teacher

Response:

```json
{
  "documentId": "uuid",
  "status": "embedding",
  "progress": {
    "stage": "embedding",
    "percent": 74,
    "pagesParsed": 18,
    "entitiesCreated": 96,
    "chunksCreated": 42,
    "chunksEmbedded": 31
  },
  "errorMessage": null,
  "updatedAt": "2026-07-10T00:00:00.000Z"
}
```

### `GET /api/rag/documents`

Role: teacher

Query:

```text
subject=Science
grade=8
status=ready
```

Response:

```json
{
  "documents": [
    {
      "documentId": "uuid",
      "filename": "Grade_8_Science_Chapter_10.pdf",
      "status": "ready",
      "metadata": {
        "grade": 8,
        "subject": "Science",
        "chapterNumber": 10,
        "chapterName": "Light: Mirrors and Lenses"
      },
      "entityCount": 96,
      "chunkCount": 42,
      "uploadedBy": "uuid",
      "createdAt": "2026-07-10T00:00:00.000Z",
      "updatedAt": "2026-07-10T00:00:00.000Z"
    }
  ]
}
```

### `GET /api/rag/retrieve`

Caller: AI service

Auth: none for internal service compatibility

Query:

```text
q=why dentists use mirrors
schoolId=uuid
subject=Science
grade=8
top=5
```

Response:

```json
{
  "chunks": [
    {
      "chunkId": "uuid",
      "entityId": "uuid",
      "canonicalConceptId": "uuid",
      "text": "Dentists use concave mirrors because...",
      "source": "NCERT Science Grade 8, Curiosity, Chapter 10, p.158",
      "score": 0.84,
      "metadata": {
        "schoolId": "uuid",
        "grade": 8,
        "subject": "Science",
        "chapterNumber": 10,
        "entityType": "Application",
        "pageStart": 158
      }
    }
  ]
}
```

AI compatibility:

- The current AI service can also handle a raw array response, but the EKE endpoint should return `{ "chunks": [...] }`.
- Each chunk must include `text`.
- Each chunk should include `source`.
- Missing or empty retrieval should return `{ "chunks": [] }`, not fake context.

### `GET /api/rag/lessons/:lessonId/context`

Caller: AI service, future Quiz service

Purpose: deterministic lesson-context assembly after a teacher chooses a lesson.

Response:

```json
{
  "lessonId": "uuid",
  "metadata": {
    "grade": 8,
    "subject": "Science",
    "chapterNumber": 10,
    "chapterName": "Light: Mirrors and Lenses"
  },
  "chunks": [
    {
      "chunkId": "uuid",
      "text": "A concave mirror is...",
      "source": "NCERT Science Grade 8, Curiosity, Chapter 10, p.155",
      "pedagogicalRole": "definition",
      "pedagogicalOrder": 10
    }
  ]
}
```

## Storage Contract

PostgreSQL owns durable ingestion records:

```text
documents
document_ingestion_events
educational_entities
entity_relationships
retrieval_chunks
```

ChromaDB owns dense vector indexes for MVP:

```text
collection: school_{schoolId}_{subject}
id: chunk.embeddingId
document: chunk.text
metadata: chunk.metadata + documentId + entityId + chunkId
```

Later indexes:

- Neo4j or graph-native storage for entity traversal.
- OpenSearch for BM25 lexical retrieval.
- Qdrant for production dense/hybrid retrieval if the stack moves beyond Chroma.

The API contract should not expose which backing index satisfied a result except as optional diagnostics.

## Retrieval Assembly Contract

Retrieval should be implemented in this order:

1. Normalize query and metadata filters.
2. Apply metadata filters before dense retrieval.
3. Retrieve candidate chunks from vector storage.
4. Expand through entity/canonical concept relationships.
5. Add hierarchy context such as parent section, sibling figure, or activity conclusion.
6. Merge and rank candidates.
7. Return pedagogically ordered top chunks.

MVP may implement only steps 1, 2, 3, and 7, but the response shape should not block graph expansion later.

## Error Shape

Errors should use a consistent JSON shape:

```json
{
  "error": "Human readable message.",
  "code": "invalid_metadata",
  "details": {
    "field": "grade"
  }
}
```

Common codes:

```text
unauthorized
forbidden
invalid_metadata
invalid_file_type
file_too_large
document_not_found
ingestion_failed
retrieval_failed
```

## Done Criteria For This Contract

- The upload UI can submit one PDF and all required metadata without guessing backend field names.
- The frontend can poll a single status endpoint until `ready` or `failed`.
- The document list can show status, chapter metadata, entity count, and chunk count.
- The AI service can keep using `/api/rag/retrieve` without changes.
- Future graph retrieval can add richer fields without breaking existing callers.
