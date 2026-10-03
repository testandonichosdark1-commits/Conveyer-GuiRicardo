import pytest

from ltx_worker.schemas import InvalidInput, parse_request

from .conftest import valid_input


def test_valid_input_parses_every_field_exactly():
    r = parse_request(valid_input())
    assert (r.prompt, r.image_path, r.output_path) == (
        "slow push-in on a quiet harbour at dawn", "jobs/k1/input.png", "jobs/k1/output.mp4",
    )
    assert (r.width, r.height, r.fps, r.num_frames, r.seed, r.image_strength) == (128, 64, 24, 17, 42, 1.0)
    assert r.duration_sec == round(17 / 24, 6)


@pytest.mark.parametrize("field", ["prompt", "imagePath", "outputPath", "width", "height", "fps", "numFrames", "seed", "imageStrength"])
def test_every_field_is_required(field):
    raw = valid_input()
    del raw[field]
    with pytest.raises(InvalidInput):
        parse_request(raw)


@pytest.mark.parametrize("prompt", ["", "   ", None, 7, "x" * 4001])
def test_prompt(prompt):
    with pytest.raises(InvalidInput, match="prompt"):
        parse_request(valid_input(prompt=prompt))


@pytest.mark.parametrize("value", [0, 63, 100, 130, -64, 2112, 64.0, "128", True, None])
def test_width_and_height_must_be_positive_multiples_of_64(value):
    for field in ("width", "height"):
        with pytest.raises(InvalidInput, match=field):
            parse_request(valid_input(**{field: value}))


def test_width_and_height_accept_multiples_of_64_within_the_cap():
    r = parse_request(valid_input(width=1920, height=1088))
    assert (r.width, r.height) == (1920, 1088)


@pytest.mark.parametrize("fps", [0, -24, 61, 23.976, "24", True])
def test_fps(fps):
    with pytest.raises(InvalidInput, match="fps"):
        parse_request(valid_input(fps=fps))


@pytest.mark.parametrize("n", [1, 9, 17, 97, 121, 257])
def test_num_frames_on_the_ltx_grid(n):
    assert parse_request(valid_input(numFrames=n)).num_frames == n


@pytest.mark.parametrize("n", [0, 2, 8, 10, 120, 122, 265, 24.0])
def test_num_frames_off_the_grid_or_out_of_range_is_rejected_not_snapped(n):
    with pytest.raises(InvalidInput, match="numFrames"):
        parse_request(valid_input(numFrames=n))


def test_off_grid_error_names_the_nearest_valid_values():
    with pytest.raises(InvalidInput, match="nearest valid values are 113 and 121"):
        parse_request(valid_input(numFrames=120))


@pytest.mark.parametrize("seed", [0, 1, 2**63 - 1])
def test_seed_range(seed):
    assert parse_request(valid_input(seed=seed)).seed == seed


@pytest.mark.parametrize("seed", [-1, 2**63, 1.5, "42", None, False])
def test_seed_invalid(seed):
    with pytest.raises(InvalidInput, match="seed"):
        parse_request(valid_input(seed=seed))


@pytest.mark.parametrize("s", [0, -0.5, 1.01, "1", None, True])
def test_image_strength(s):
    with pytest.raises(InvalidInput, match="imageStrength"):
        parse_request(valid_input(imageStrength=s))


def test_unknown_fields_are_rejected_not_ignored():
    with pytest.raises(InvalidInput, match="durationSec"):
        parse_request(valid_input(durationSec=5))


def test_input_must_be_an_object():
    for raw in (None, [], "x", 3):
        with pytest.raises(InvalidInput):
            parse_request(raw)
