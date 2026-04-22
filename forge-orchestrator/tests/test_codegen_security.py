import pytest

from agents.codegen import sanitize_prompt_text, validate_generated_files
from agents.requirements import _validate_requirements_output


def test_generated_file_paths_are_normalized_to_workspace_relative_names():
    files = validate_generated_files({"./src\\App.jsx": "export default function App() {}"})

    assert files == {"src/App.jsx": "export default function App() {}"}


@pytest.mark.parametrize(
    "path",
    [
        "../outside.js",
        "/tmp/outside.js",
        "C:/tmp/outside.js",
        "node_modules/pkg/index.js",
        ".env",
        "src/private.pem",
    ],
)
def test_generated_file_paths_reject_unsafe_names(path):
    with pytest.raises(ValueError):
        validate_generated_files({path: "secret"})


def test_prompt_text_sanitizer_removes_control_chars_and_bounds_length():
    sanitized = sanitize_prompt_text("ok\x00bad\n" + ("x" * 20), 8)

    assert sanitized == "ok bad\nx"


def test_requirements_output_is_schema_normalized():
    spec = _validate_requirements_output(
        {
            "title": "Build timer",
            "description": "Create a countdown timer",
            "acceptance_criteria": ["starts", "stops"],
            "edge_cases": None,
            "dependencies": [],
            "estimated_complexity": "low",
            "unexpected": "ignored",
        },
        "timer",
        "",
    )

    assert spec == {
        "title": "Build timer",
        "description": "Create a countdown timer",
        "acceptance_criteria": ["starts", "stops"],
        "edge_cases": [],
        "dependencies": [],
        "estimated_complexity": "low",
    }


def test_requirements_output_falls_back_on_invalid_schema():
    spec = _validate_requirements_output({"title": "", "description": ""}, "Build a timer", "")

    assert spec["title"] == "Build a timer"
    assert spec["estimated_complexity"] == "medium"
