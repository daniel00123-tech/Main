import unittest

from scripts.bigchange_btr_allocation import allowed_resource_roles, determine_role


def job(**overrides):
    base = {
        "Ref": "JOB1",
        "Type": "",
        "Category": "",
        "Description": "",
        "Contact": "Leodis Square",
        "Location": "",
        "CurrentFlag": "",
        "CustNote": "",
        "ResNote": "",
        "StatusComment": "",
        "Status": "New",
    }
    base.update(overrides)
    return base


class BtrRoleAssignmentTest(unittest.TestCase):
    def test_routes_cleaning_call_out_to_housekeeping(self) -> None:
        role = determine_role(
            job(
                Type="Cleaning Call Out",
                Description="Cleaning required in apartment after move out",
            )
        )

        self.assertEqual(role.role, "HK")

    def test_routes_eot_cleaning_to_housekeeping(self) -> None:
        role = determine_role(
            job(
                Type="EOT - End Of Tenancy Cleaning",
                Description="End of tenancy cleaning required",
            )
        )

        self.assertEqual(role.role, "HK")

    def test_does_not_route_appliance_issue_to_housekeeping(self) -> None:
        role = determine_role(
            job(
                Type="Building Call Out",
                Category="Housekeeping",
                Description="Washing machine issue in apartment",
            )
        )

        self.assertEqual(role.role, "Tech")

    def test_does_not_route_access_door_issue_to_housekeeping(self) -> None:
        role = determine_role(
            job(
                Type="Building Call Out",
                Category="Cleaning",
                Description="Access door lock fault",
            )
        )

        self.assertEqual(role.role, "Tech")

    def test_routes_eot_beautification_to_tech(self) -> None:
        role = determine_role(
            job(
                Type="EOT - Beautification Paint & Repair Works",
                Description="Paint and repair works after checkout",
            )
        )

        self.assertEqual(role.role, "Tech")

    def test_routes_eot_assessment_to_tech(self) -> None:
        role = determine_role(
            job(
                Type="EOT - Assessment Checkout Condition Review",
                Description="Checkout condition assessment",
            )
        )

        self.assertEqual(role.role, "Tech")

    def test_routes_communal_clean_to_caretaker(self) -> None:
        role = determine_role(
            job(
                Type="Cleaning Call Out",
                Description="Clean communal lobby and lift",
            )
        )

        self.assertEqual(role.role, "CT")

    def test_routes_bins_to_caretaker(self) -> None:
        role = determine_role(
            job(
                Type="BTR - Bins Out",
                Description="Move wheelie bins out for collection",
            )
        )

        self.assertEqual(role.role, "CT")

    def test_routes_basic_ppm_to_caretaker(self) -> None:
        role = determine_role(
            job(
                Ref="PPM123",
                Type="PPM - Daily Internal Inspection BTR",
                Description="Daily internal inspection of communal areas",
            )
        )

        self.assertEqual(role.role, "CT")

    def test_routes_reactive_fixflo_to_tech(self) -> None:
        role = determine_role(
            job(
                Type="DL - Tech Job from FixFlo",
                Description="Resident reported fridge fault",
            )
        )

        self.assertEqual(role.role, "Tech")

    def test_resource_role_routes_are_strict(self) -> None:
        rules = {
            "role_assignment": {
                "resource_roles": {
                    "HK": ["HK"],
                    "CT": ["CT"],
                    "Tech": ["Tech"],
                }
            }
        }

        self.assertEqual(allowed_resource_roles("HK", "Leodis Square", rules), {"HK"})
        self.assertEqual(allowed_resource_roles("CT", "Leodis Square", rules), {"CT"})
        self.assertEqual(allowed_resource_roles("Tech", "Leodis Square", rules), {"Tech"})


if __name__ == "__main__":
    unittest.main()
