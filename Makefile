.PHONY: install run dry-run compile

install:
	python3 -m pip install --user -r requirements.txt

run:
	python3 scripts/weekly_door_to_door_timesheets.py

dry-run:
	python3 scripts/weekly_door_to_door_timesheets.py --dry-run-email

compile:
	python3 -m py_compile scripts/weekly_door_to_door_timesheets.py
