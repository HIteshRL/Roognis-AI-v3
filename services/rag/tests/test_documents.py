from pathlib import Path

import fitz
import pytest
from sqlalchemy import select

import main as rag_main
from database import SessionLocal
from main import app
from models import (
    Document,
    DocumentIngestionJob,
    DocumentStatus,
    EducationalEntity,
    EntityRelationship,
    EntityType,
    IngestionJobStatus,
    RetrievalChunk,
)


DEFAULT_SCHOOL_ID = "22222222-2222-2222-2222-222222222222"


def upload_pdf(client, **overrides):
    data = {
        "board": "CBSE",
        "curriculum": "NCERT",
        "grade": "8",
        "subject": "Science",
        "book": "Curiosity",
        "chapterNumber": "10",
        "chapterName": "Light: Mirrors and Lenses",
        "language": "English",
        "edition": "2026-27",
        "schoolId": DEFAULT_SCHOOL_ID,
        **overrides,
    }
    return client.post(
        "/api/rag/upload",
        data=data,
        files={"file": ("chapter 10.pdf", sample_pdf_bytes(), "application/pdf")},
    )


def sample_pdf_bytes(lines: list[str] | None = None) -> bytes:
    content = lines or [
        "10 Light: Mirrors and Lenses",
        "10.1 Reflection of Light",
        "Definition: Reflection is the bouncing back of light from a surface.",
        "Activity 10.1: Look at your face in a spoon.",
        "Observation: The image may look larger in a curved spoon.",
        "Uses of Concave Mirror: Dentists use concave mirrors to see enlarged images.",
        "Exercise",
        "Why do dentists use mirrors?",
    ]
    document = fitz.open()
    page = document.new_page()
    y = 72
    for line in content:
        page.insert_text((72, y), line, fontsize=11)
        y += 24
    return document.tobytes()


def test_upload_persists_document_and_returns_contract_response(client):
    response = upload_pdf(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["documentId"]
    assert payload["status"] == "ready"
    assert payload["entitiesCreated"] > 0
    assert payload["chunksCreated"] > 0
    assert payload["chunksEmbedded"] == payload["chunksCreated"]
    assert payload["collection"].startswith("school_")
    assert payload["metadata"]["schoolId"] == "22222222-2222-2222-2222-222222222222"
    assert payload["metadata"]["board"] == "CBSE"
    assert payload["metadata"]["curriculum"] == "NCERT"
    assert payload["metadata"]["grade"] == 8
    assert payload["metadata"]["chapterNumber"] == 10
    assert payload["metadata"]["sourceType"] == "ncert_textbook"

    storage_root = Path(app.state.settings.file_storage_path)
    assert (storage_root / "rag" / "uploads" / f"{payload['documentId']}.pdf").exists()


def test_status_returns_completed_chunking_progress(client):
    upload = upload_pdf(client).json()

    response = client.get(f"/api/rag/upload/{upload['documentId']}/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["documentId"] == upload["documentId"]
    assert payload["status"] == "ready"
    assert payload["progress"]["stage"] == "ready"
    assert payload["progress"]["percent"] == 100
    assert payload["progress"]["pagesParsed"] == 1
    assert payload["progress"]["entitiesCreated"] > 0
    assert payload["progress"]["chunksCreated"] > 0
    assert payload["progress"]["chunksEmbedded"] == payload["progress"]["chunksCreated"]
    assert payload["errorMessage"] is None
    assert payload["updatedAt"]


# Renamed: the list is no longer school-scoped (auth removed), only filterable.
def test_document_list_is_filterable(client):
    science_doc = upload_pdf(client).json()
    upload_pdf(client, subject="Maths", chapterName="Fractions")

    response = client.get("/api/rag/documents?subject=Science&grade=8&status=ready")

    assert response.status_code == 200
    documents = response.json()["documents"]
    assert len(documents) == 1
    assert documents[0]["documentId"] == science_doc["documentId"]
    assert documents[0]["metadata"] == {
        "board": "CBSE",
        "curriculum": "NCERT",
        "grade": 8,
        "subject": "Science",
        "chapterNumber": 10,
        "chapterName": "Light: Mirrors and Lenses",
    }
    assert documents[0]["entityCount"] > 0
    assert documents[0]["chunkCount"] > 0


# Auth removed: the status endpoint is no longer school-scoped, so a document
# from another school is now readable. The only 404 left is an unknown id.
def test_status_returns_404_for_unknown_document(client):
    upload_pdf(client)

    response = client.get("/api/rag/upload/44444444-4444-4444-4444-444444444444/status")

    assert response.status_code == 404
    assert response.json()["detail"] == "Document not found."


def test_status_is_readable_across_schools(client):
    upload = upload_pdf(client, schoolId="33333333-3333-3333-3333-333333333333").json()

    response = client.get(f"/api/rag/upload/{upload['documentId']}/status")

    assert response.status_code == 200


def test_upload_rejects_non_pdf_file(client):
    response = client.post(
        "/api/rag/upload",
        data={
            "board": "CBSE",
            "curriculum": "NCERT",
            "grade": "8",
            "subject": "Science",
            "book": "Curiosity",
            "chapterNumber": "10",
            "chapterName": "Light: Mirrors and Lenses",
            "language": "English",
            "edition": "2026-27",
        },
        files={"file": ("chapter.txt", b"not a pdf", "text/plain")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Only PDF uploads are supported."


@pytest.mark.parametrize(
    ("overrides", "detail"),
    [
        ({"grade": "13"}, "grade must be between 1 and 12."),
        ({"chapterNumber": "0"}, "chapterNumber must be positive."),
        ({"subject": "   "}, "subject is required."),
    ],
)
def test_upload_rejects_invalid_metadata(client, overrides, detail):
    response = upload_pdf(client, **overrides)

    assert response.status_code == 400
    assert response.json()["detail"] == detail


def test_upload_rejects_empty_pdf(client):
    response = client.post(
        "/api/rag/upload",
        data={
            "board": "CBSE",
            "curriculum": "NCERT",
            "grade": "8",
            "subject": "Science",
            "book": "Curiosity",
            "chapterNumber": "10",
            "chapterName": "Light: Mirrors and Lenses",
            "language": "English",
            "edition": "2026-27",
        },
        files={"file": ("empty.pdf", b"", "application/pdf")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Uploaded PDF is empty."


def test_failed_ingestion_persists_failed_status_for_status_endpoint(client, monkeypatch):
    def fail_extraction(*_args, **_kwargs):
        raise RuntimeError("parser unavailable")

    monkeypatch.setattr(rag_main, "run_entity_extraction", fail_extraction)

    response = upload_pdf(client)

    with SessionLocal() as db:
        document = db.scalar(select(Document).limit(1))
        job = db.scalar(
            select(DocumentIngestionJob)
            .where(DocumentIngestionJob.document_id == document.id)
            .limit(1)
        )

    status_response = client.get(f"/api/rag/upload/{document.id}/status")
    status_payload = status_response.json()

    assert response.status_code == 400
    assert response.json()["detail"] == "Document ingestion failed."
    assert document.status == DocumentStatus.FAILED.value
    assert document.error_message == "Ingestion failed: parser unavailable"
    assert job.status == IngestionJobStatus.FAILED.value
    assert job.stage == DocumentStatus.FAILED.value
    assert job.error_message == document.error_message
    assert status_response.status_code == 200
    assert status_payload["status"] == DocumentStatus.FAILED.value
    assert status_payload["progress"]["stage"] == DocumentStatus.FAILED.value
    assert status_payload["errorMessage"] == document.error_message


def test_upload_extracts_canonical_concepts_and_classified_entities(client):
    payload = upload_pdf(client).json()

    with SessionLocal() as db:
        entities = db.scalars(
            select(EducationalEntity).where(EducationalEntity.document_id == payload["documentId"])
        ).all()
        relationships = db.scalars(
            select(EntityRelationship).where(EntityRelationship.document_id == payload["documentId"])
        ).all()

    entity_types = {entity.entity_type for entity in entities}
    canonical_titles = {
        entity.title
        for entity in entities
        if entity.entity_type == EntityType.CANONICAL_CONCEPT.value
    }
    definition = next(
        entity for entity in entities if entity.entity_type == EntityType.DEFINITION.value
    )

    assert EntityType.CANONICAL_CONCEPT.value in entity_types
    assert EntityType.DEFINITION.value in entity_types
    assert EntityType.ACTIVITY.value in entity_types
    assert EntityType.APPLICATION.value in entity_types
    assert EntityType.QUESTION.value in entity_types
    assert "Reflection of Light" in canonical_titles
    assert "Concave Mirror" in canonical_titles
    assert definition.canonical_concept_id
    assert definition.metadata_json["sourceType"] == "ncert_textbook"
    assert relationships


def test_upload_generates_semantic_chunks_with_embedding_metadata(client):
    payload = upload_pdf(client).json()

    with SessionLocal() as db:
        chunks = db.scalars(
            select(RetrievalChunk)
            .where(RetrievalChunk.document_id == payload["documentId"])
            .order_by(RetrievalChunk.chunk_index.asc())
        ).all()

    assert chunks
    assert all(chunk.vector_id for chunk in chunks)
    assert all(chunk.metadata_json["schoolId"] == "22222222-2222-2222-2222-222222222222" for chunk in chunks)
    assert all(chunk.metadata_json["grade"] == 8 for chunk in chunks)
    assert all(chunk.metadata_json["subject"] == "Science" for chunk in chunks)
    assert all(chunk.metadata_json["chapterNumber"] == 10 for chunk in chunks)
    assert all(chunk.metadata_json["collection"] == payload["collection"] for chunk in chunks)
    assert all(chunk.source.startswith("NCERT Science Grade 8") for chunk in chunks)
    assert all(chunk.token_count and chunk.token_count > 0 for chunk in chunks)
    assert all(chunk.pedagogical_order is not None for chunk in chunks)
    assert all(chunk.metadata_json["entityId"] == chunk.entity_id for chunk in chunks)
    assert all(chunk.metadata_json["canonicalConceptId"] == chunk.canonical_concept_id for chunk in chunks)
    assert any("Dentists use concave mirrors" in chunk.text for chunk in chunks)
    assert any(chunk.chunk_type == "question" for chunk in chunks)


# Auth removed: school is no longer a boundary. An unfiltered list returns every
# school's documents; passing schoolId narrows it, but only as a convenience filter.
def test_document_list_spans_schools_unless_filtered(client):
    school_a = "22222222-2222-2222-2222-222222222222"
    school_b = "33333333-3333-3333-3333-333333333333"
    school_a_doc = upload_pdf(client).json()
    school_b_doc = upload_pdf(
        client,
        schoolId=school_b,
        subject="Science",
        chapterName="Light in Another School",
    ).json()

    unfiltered = client.get("/api/rag/documents?status=ready")
    filtered = client.get(f"/api/rag/documents?status=ready&schoolId={school_a}")

    all_ids = {document["documentId"] for document in unfiltered.json()["documents"]}
    assert unfiltered.status_code == 200
    assert school_a_doc["documentId"] in all_ids
    assert school_b_doc["documentId"] in all_ids

    filtered_ids = {document["documentId"] for document in filtered.json()["documents"]}
    assert filtered.status_code == 200
    assert filtered_ids == {school_a_doc["documentId"]}


def test_document_list_rejects_bad_status_filter(client):
    bad_filter = client.get("/api/rag/documents?status=unknown")

    assert bad_filter.status_code == 400
    assert bad_filter.json()["detail"] == "Invalid document status filter."
