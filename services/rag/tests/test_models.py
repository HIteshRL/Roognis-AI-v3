from database import Base
from models import DocumentStatus, EntityType, IngestionJobStatus


def test_lifecycle_tables_are_registered():
    assert {
        "documents",
        "document_ingestion_jobs",
        "educational_entities",
        "entity_relationships",
        "retrieval_chunks",
    }.issubset(Base.metadata.tables.keys())


def test_lifecycle_enums_match_contract_names():
    assert DocumentStatus.QUEUED.value == "queued"
    assert DocumentStatus.GRAPH_BUILDING.value == "graph_building"
    assert IngestionJobStatus.SUCCEEDED.value == "succeeded"
    assert EntityType.CANONICAL_CONCEPT.value == "CanonicalConcept"
