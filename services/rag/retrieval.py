from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from config import Settings, get_settings
from models import Document, DocumentStatus, RetrievalChunk

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RetrievalFilters:
    q: str
    school_id: str
    subject: str | None = None
    grade: int | None = None
    board: str | None = None
    curriculum: str | None = None
    chapter_number: int | None = None
    top: int = 5


class VectorRetrievalClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._ollama_client = None
        self._chroma_client = None
        self._collections = {}

    def embed_query(self, text: str) -> list[float]:
        client = self._get_ollama_client()
        response = client.embeddings(model=self.settings.ollama_embedding_model, prompt=text)
        embedding = getattr(response, "embedding", None)
        if embedding is None and isinstance(response, dict):
            embedding = response.get("embedding")
        if not embedding:
            raise RuntimeError("Ollama returned an empty query embedding.")
        return [float(value) for value in embedding]

    def collection(self, collection_name: str):
        if collection_name not in self._collections:
            self._collections[collection_name] = self._get_chroma_client().get_collection(name=collection_name)
        return self._collections[collection_name]

    def _get_ollama_client(self):
        if self._ollama_client is None:
            import ollama

            self._ollama_client = ollama.Client(host=self.settings.ollama_url)
        return self._ollama_client

    def _get_chroma_client(self):
        if self._chroma_client is not None:
            return self._chroma_client
        import chromadb

        parsed = urlparse(self.settings.chroma_url)
        host = parsed.hostname or self.settings.chroma_url
        port = parsed.port or (443 if parsed.scheme == "https" else 8000)
        self._chroma_client = chromadb.HttpClient(
            host=host,
            port=port,
            ssl=parsed.scheme == "https",
        )
        return self._chroma_client


STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "do",
    "does",
    "for",
    "from",
    "how",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "use",
    "used",
    "what",
    "when",
    "where",
    "which",
    "why",
}


def retrieve_chunks(
    db: Session,
    filters: RetrievalFilters,
    settings: Settings | None = None,
) -> list[dict]:
    settings = settings or get_settings()
    query_terms = tokenize(filters.q)
    if not filters.school_id.strip():
        return []

    candidates = load_candidate_chunks(db, filters)
    if not candidates:
        return []

    ranked = []
    lexical_ranked = lexical_rank_chunks(candidates, query_terms)
    if query_terms and not settings.rag_test_mode:
        try:
            vector_ranked = vector_rank_chunks(candidates, filters, settings)
            ranked = hybrid_rank_chunks(vector_ranked, lexical_ranked)
        except Exception as exc:
            logger.warning("Vector retrieval failed; falling back to SQL lexical ranking: %s", exc)

    if not ranked:
        ranked = lexical_ranked

    return [
        chunk_response(chunk, score)
        for score, chunk in ranked[: filters.top]
    ]


def load_candidate_chunks(db: Session, filters: RetrievalFilters) -> list[RetrievalChunk]:
    statement = (
        select(RetrievalChunk)
        .join(Document, RetrievalChunk.document_id == Document.id)
        .where(
            RetrievalChunk.school_id == filters.school_id.strip(),
            RetrievalChunk.vector_id.is_not(None),
            Document.status == DocumentStatus.READY.value,
        )
        .order_by(RetrievalChunk.pedagogical_order.asc().nullslast(), RetrievalChunk.chunk_index.asc())
    )

    if filters.subject:
        statement = statement.where(RetrievalChunk.subject.ilike(filters.subject.strip()))
    if filters.grade is not None:
        statement = statement.where(RetrievalChunk.grade == filters.grade)
    if filters.board:
        statement = statement.where(RetrievalChunk.board.ilike(filters.board.strip()))
    if filters.curriculum:
        statement = statement.where(RetrievalChunk.curriculum.ilike(filters.curriculum.strip()))
    if filters.chapter_number is not None:
        statement = statement.where(RetrievalChunk.chapter_number == filters.chapter_number)

    return db.scalars(statement).all()


def vector_rank_chunks(
    candidates: list[RetrievalChunk],
    filters: RetrievalFilters,
    settings: Settings,
) -> list[tuple[float, RetrievalChunk]]:
    client = VectorRetrievalClient(settings)
    query_embedding = client.embed_query(filters.q)
    chunks_by_vector_id = {
        chunk.vector_id: chunk
        for chunk in candidates
        if chunk.vector_id
    }
    chunks_by_collection = group_chunks_by_collection(candidates)
    if not chunks_by_vector_id or not chunks_by_collection:
        return []

    ranked = []
    seen_chunk_ids = set()
    where = chroma_where(filters)
    per_collection_limit = min(max(filters.top * 4, filters.top), 50)

    for collection_name, collection_chunks in chunks_by_collection.items():
        n_results = min(per_collection_limit, len(collection_chunks))
        if n_results <= 0:
            continue
        collection = client.collection(collection_name)
        result = collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=where,
        )
        ids = first_query_values(result.get("ids"))
        distances = first_query_values(result.get("distances"))
        for vector_id, distance in zip(ids, distances):
            chunk = chunks_by_vector_id.get(vector_id)
            if not chunk or chunk.id in seen_chunk_ids:
                continue
            ranked.append((score_from_distance(distance), chunk))
            seen_chunk_ids.add(chunk.id)

    ranked.sort(key=rank_sort_key)
    return ranked


def lexical_rank_chunks(
    candidates: list[RetrievalChunk],
    query_terms: list[str],
) -> list[tuple[float, RetrievalChunk]]:
    scored = [
        (score_chunk(chunk, query_terms), chunk)
        for chunk in candidates
    ]
    scored = [(score, chunk) for score, chunk in scored if score > 0 or not query_terms]
    scored.sort(key=rank_sort_key)
    return scored


def hybrid_rank_chunks(
    vector_ranked: list[tuple[float, RetrievalChunk]],
    lexical_ranked: list[tuple[float, RetrievalChunk]],
) -> list[tuple[float, RetrievalChunk]]:
    if not vector_ranked:
        return lexical_ranked

    lexical_max = max((score for score, _chunk in lexical_ranked), default=0.0) or 1.0
    combined = {}

    for score, chunk in vector_ranked:
        combined[chunk.id] = {
            "chunk": chunk,
            "vector": max(float(score), 0.0),
            "lexical": 0.0,
        }

    for score, chunk in lexical_ranked:
        entry = combined.setdefault(
            chunk.id,
            {
                "chunk": chunk,
                "vector": 0.0,
                "lexical": 0.0,
            },
        )
        entry["lexical"] = max(float(score), 0.0) / lexical_max

    ranked = [
        (
            round((entry["vector"] * 0.72) + (entry["lexical"] * 0.28), 6),
            entry["chunk"],
        )
        for entry in combined.values()
    ]
    ranked = [(score, chunk) for score, chunk in ranked if score > 0]
    ranked.sort(key=rank_sort_key)
    return ranked


def group_chunks_by_collection(candidates: list[RetrievalChunk]) -> dict[str, list[RetrievalChunk]]:
    grouped = {}
    for chunk in candidates:
        collection_name = str((chunk.metadata_json or {}).get("collection") or "").strip()
        if not collection_name:
            continue
        grouped.setdefault(collection_name, []).append(chunk)
    return grouped


def chroma_where(filters: RetrievalFilters) -> dict:
    clauses = [{"schoolId": filters.school_id.strip()}]
    if filters.subject:
        clauses.append({"subject": filters.subject.strip()})
    if filters.grade is not None:
        clauses.append({"grade": filters.grade})
    if filters.board:
        clauses.append({"board": filters.board.strip()})
    if filters.curriculum:
        clauses.append({"curriculum": filters.curriculum.strip()})
    if filters.chapter_number is not None:
        clauses.append({"chapterNumber": filters.chapter_number})
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def first_query_values(values) -> list:
    if not values:
        return []
    return values[0] or []


def score_from_distance(distance) -> float:
    try:
        numeric_distance = max(float(distance), 0.0)
    except (TypeError, ValueError):
        numeric_distance = 0.0
    return round(1 / (1 + numeric_distance), 6)


def rank_sort_key(item: tuple[float, RetrievalChunk]) -> tuple:
    score, chunk = item
    return (
        -score,
        chunk.pedagogical_order if chunk.pedagogical_order is not None else 999_999,
        chunk.chunk_index,
    )


def score_chunk(chunk: RetrievalChunk, query_terms: list[str]) -> float:
    if not query_terms:
        return 0.1

    metadata = chunk.metadata_json or {}
    weighted_text = " ".join(
        [
            chunk.text or "",
            str(metadata.get("entityType") or ""),
            str(metadata.get("chapterName") or ""),
            str(metadata.get("section") or ""),
        ]
    )
    chunk_terms = tokenize(weighted_text, keep_duplicates=True)
    if not chunk_terms:
        return 0.0

    frequency = {}
    for term in chunk_terms:
        frequency[term] = frequency.get(term, 0) + 1

    unique_query_terms = set(query_terms)
    overlap = unique_query_terms.intersection(frequency)
    if not overlap:
        return 0.0

    exact_phrase_boost = (
        0.35
        if normalize_for_phrase(" ".join(query_terms)) in normalize_for_phrase(weighted_text)
        else 0
    )
    term_score = sum(1 + math.log(frequency[term]) for term in overlap)
    coverage = len(overlap) / len(unique_query_terms)
    density = term_score / math.sqrt(len(chunk_terms))
    type_boost = pedagogical_type_boost(str(metadata.get("entityType") or ""))
    order_boost = 0.05 if (chunk.pedagogical_order or 0) < 30_000 else 0

    return round((coverage * 0.65) + (density * 0.25) + exact_phrase_boost + type_boost + order_boost, 6)


def chunk_response(chunk: RetrievalChunk, score: float) -> dict:
    metadata = chunk.metadata_json or {}
    return {
        "chunkId": chunk.id,
        "entityId": chunk.entity_id,
        "canonicalConceptId": chunk.canonical_concept_id,
        "text": chunk.text,
        "source": chunk.source,
        "score": score,
        "metadata": {
            "schoolId": chunk.school_id,
            "grade": chunk.grade,
            "subject": chunk.subject,
            "chapterNumber": chunk.chapter_number,
            "chapterName": chunk.chapter_name,
            "entityType": metadata.get("entityType"),
            "pageStart": chunk.page_start,
            "pageEnd": chunk.page_end,
        },
    }


def tokenize(value: str, *, keep_duplicates: bool = False) -> list[str]:
    terms = [
        normalize_term(term)
        for term in re.findall(r"[A-Za-z0-9]+", value or "")
    ]
    filtered = [term for term in terms if len(term) > 1 and term not in STOPWORDS]
    if keep_duplicates:
        return filtered
    return list(dict.fromkeys(filtered))


def normalize_term(value: str) -> str:
    value = value.lower()
    for suffix in ("ing", "ed", "es", "s"):
        if len(value) > len(suffix) + 3 and value.endswith(suffix):
            return value[: -len(suffix)]
    return value


def normalize_for_phrase(value: str) -> str:
    return " ".join(tokenize(value, keep_duplicates=True))


def pedagogical_type_boost(entity_type: str) -> float:
    return {
        "Definition": 0.08,
        "Concept": 0.06,
        "Application": 0.05,
        "Example": 0.04,
        "Question": 0.03,
    }.get(entity_type, 0.0)
